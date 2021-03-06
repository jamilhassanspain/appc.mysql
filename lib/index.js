var _ = require('lodash'),
	async = require('async'),
	mysql = require('../node_modules/mysql'),
	pkginfo = require('pkginfo')(module) && module.exports,
	defaultConfig = require('fs').readFileSync(__dirname + '/../conf/example.config.js', 'utf8');

// --------- MYSQL DB Connector -------

exports.create = function (Arrow, server) {
	var Connector = Arrow.Connector,
		Collection = Arrow.Collection;

	return Connector.extend({

		/*
		 Configuration.
		 */
		pkginfo: _.pick(pkginfo, 'name', 'version', 'description', 'author', 'license', 'keywords', 'repository'),
		logger: server && server.logger || Arrow.createLogger({}, { name: pkginfo.name }),

		/*
		 Lifecycle.
		 */
		connect: function (callback) {
			this.logger.trace('connecting');

			var connected = function connectedCallback(err) {
				if (err) {
					callback(err);
				}
				else {
					this.logger.trace('connected');
					this.fetchSchema(function fetchedSchema(err, schema) {
						if (err) {
							callback(err);
						}
						else {
							this.schema = schema;
							if (this.config.generateModelsFromSchema === undefined || this.config.generateModelsFromSchema) {
								this.createModelsFromSchema();
							}
							callback();
						}
					}.bind(this));
				}
			}.bind(this);

			if (this.config.connection_pooling || this.config.connectionPooling) {
				this.pool = mysql.createPool(this.config);
				this.logger.trace('created MYSQL connection pool');
				this.pool.getConnection(function pooledGetConnection(err, connection) {
					if (err) {
						callback(err);
					}
					else {
						connection.release();
						connected(err);
					}
				}.bind(this));
			}
			else {
				this.logger.trace('not using a MYSQL connection pool');
				this.connection = mysql.createConnection(this.config);
				this.connection.connect(connected);
			}
		},
		disconnect: function (callback) {
			this.logger.trace('disconnecting');
			(this.pool || this.connection).end(function () {
				this.logger.trace('disconnected');
				callback();
			}.bind(this));
		},

		/*
		 Metadata.
		 */
		defaultConfig: defaultConfig,
		fetchSchema: function (callback) {
			// if we already have the schema, just return it
			if (this.schema) { return callback(null, this.schema); }
			this.logger.trace('fetchSchema');
			var query = 'SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ?';
			this._query(query, [this.config.database], callback, function (results) {
				var schema = { objects: {}, database: this.config.database, primary_keys: {} };
				results.forEach(function resultCallback(result) {
					var entry = schema.objects[result.TABLE_NAME];
					if (!entry) {
						schema.objects[result.TABLE_NAME] = entry = {};
					}
					entry[result.COLUMN_NAME] = result;
					if (result.COLUMN_KEY === 'PRI') {
						schema.primary_keys[result.TABLE_NAME] = result.COLUMN_NAME;
					}
				});
				callback(null, schema);
			}.bind(this));
		},
		createModelsFromSchema: function () {
			var models = {};
			for (var modelName in this.schema.objects) {
				if (this.schema.objects.hasOwnProperty(modelName)) {
					var object = this.schema.objects[modelName],
						fields = {};
					for (var fieldName in object) {
						if (object.hasOwnProperty(fieldName)) {
							if (fieldName === 'id') {
								continue;
							}
							fields[fieldName] = {
								type: this.convertDataTypeToJSType(object[fieldName].DATA_TYPE),
								required: object.IS_NULLABLE === 'NO'
							};
						}
					}

					var Model = Arrow.Model.extend(pkginfo.name + '/' + modelName, {
						name: pkginfo.name + '/' + modelName,
						autogen: !!this.config.modelAutogen,
						fields: fields,
						connector: this,
						generated: true
					});
					models[pkginfo.name + '/' + modelName] = Model;
					if (server) {
						server.addModel(Model);
					}
				}
			}
			this.models = _.defaults(this.models || {}, models);
			if (server) {
				server.registerModelsForConnector(this, this.models);
			}
		},

		/*
		 CRUD.
		 */
		create: function (Model, values, callback) {
			var table = this.getTableName(Model),
				payload = Model.instance(values, false).toPayload(),
				primaryKeyColumn = this.getPrimaryKeyColumn(Model),
				columns = this.fetchColumns(table, payload),
				placeholders = columns.map(function () { return '?'; }),
				query;

			if (!primaryKeyColumn) {
				query = 'INSERT INTO ' + table + ' (' + this.escapeKeys(columns).join(',') + ') VALUES (' + placeholders.join(',') + ')';
			}
			else {
				query = 'INSERT INTO ' + table + ' (' + primaryKeyColumn + ',' + this.escapeKeys(columns).join(',') + ') VALUES (NULL, ' + placeholders.join(',') + ')';
			}
			var data = _.values(payload);
			this._query(query, data, callback, function (result) {
				if (result && result.affectedRows) {
					var instance = Model.instance(values),
						primaryKey = primaryKeyColumn && this.metadata.schema.objects[table][primaryKeyColumn];
					// if this is an auto_increment int primary key, we can just set it from result,
					// otherwise we need to fetch it
					if (primaryKey) {
						if (primaryKey.EXTRA === 'auto_increment') {
							instance.setPrimaryKey(result.insertId);
							callback(null, instance);
						}
						else {
							//TODO: not sure what to do for this...
							this.logger.warn("Not sure how to handle result with non auto_increment primary key type", query);
							callback(new Arrow.ORMError("Not sure how to handle result with non auto_increment primary key type"));
						}
					}
					else {
						callback(null, instance);
					}
				}
				else {
					callback();
				}
			}.bind(this));
		},
		findAll: function (Model, callback) {
			var table = this.getTableName(Model),
				primaryKeyColumn = this.getPrimaryKeyColumn(Model);

			var query = 'SELECT ' +
				(primaryKeyColumn ? primaryKeyColumn + ', ' : '') + this.escapeKeys(Model.payloadKeys()).join(', ') +
				' FROM ' + table + ' ORDER BY ' + primaryKeyColumn + ' LIMIT 1000';

			this._query(query, callback, function (results) {
				var rows = [];
				results.forEach(function rowIterator(row) {
					rows.push(this.getInstanceFromRow(Model, row));
				}.bind(this));
				callback(null, new Collection(Model, rows));
			}.bind(this));

		},
		findOne: function (Model, id, callback) {
			var table = this.getTableName(Model),
				primaryKeyColumn = this.getPrimaryKeyColumn(Model),
				query = 'SELECT ' +
					(primaryKeyColumn ? primaryKeyColumn + ', ' : '') + this.escapeKeys(Model.payloadKeys()).join(', ') +
					' FROM ' + table + ' WHERE ' + primaryKeyColumn + ' = ? LIMIT 1';
			if (!primaryKeyColumn) {
				return callback(new Arrow.ORMError("can't find primary key column for " + table));
			}
			this._query(query, id, callback, function (rows) {
				if (rows && rows.length) {
					callback(null, this.getInstanceFromRow(Model, rows[0]));
				}
				else {
					callback();
				}
			}.bind(this));
		},
		query: function (Model, options, callback) {
			// TODO: Parse through this and think about injection attack vectors.
			var key,
				table = this.getTableName(Model),
				primaryKeyColumn = this.getPrimaryKeyColumn(Model),
				keys = primaryKeyColumn,
				whereQuery = '',
				pagingQuery = '',
				orderQuery = '',
				values = [];

			var sel = Model.translateKeysForPayload(options.sel),
				unsel = Model.translateKeysForPayload(options.unsel);
			if (sel && Object.keys(sel).length > 0) {
				keys += ', ' + this.escapeKeys(_.keys(_.omit(sel, primaryKeyColumn))).join(', ');
			}
			else if (unsel && Object.keys(unsel).length > 0) {
				keys += ', ' + this.escapeKeys(_.keys(_.omit(_.omit(this.getTableSchema(Model), primaryKeyColumn), _.keys(unsel)))).join(', ');
			}
			else {
				keys = '*';
			}

			var where = Model.translateKeysForPayload(options.where);
			if (where && Object.keys(where).length > 0) {
				var firstWhere = true;
				for (key in where) {
					if (where.hasOwnProperty(key) && where[key] !== undefined) {
						if (firstWhere) {
							whereQuery = ' WHERE';
						}
						if (!firstWhere) {
							whereQuery += ' AND';
						}
						whereQuery += ' `' + key + '`';
						firstWhere = false;
						if (where[key] && where[key].$like) {
							whereQuery += ' LIKE';
							values.push(where[key].$like);
						}
						else {
							whereQuery += ' =';
							values.push(where[key]);
						}
						whereQuery += ' ?';
					}
				}
			}

			var order = Model.translateKeysForPayload(options.order);
			if (order && Object.keys(order).length > 0) {
				orderQuery = ' ORDER BY';
				for (key in order) {
					if (order.hasOwnProperty(key)) {
						orderQuery += ' ' + key + ' ';
						if (order[key] == 1) {
							orderQuery += 'ASC';
						}
						else {
							orderQuery += 'DESC';
						}
						orderQuery += ',';
					}
				}
				if (orderQuery[orderQuery.length - 1] === ',') {
					orderQuery = orderQuery.slice(0, -1);
				}
			}

			pagingQuery += ' LIMIT ' + (+options.limit);
			if (options.skip) {
				pagingQuery += ' OFFSET ' + (+options.skip);
			}

			var query = 'SELECT ' + keys + ' FROM ' + table + whereQuery + orderQuery + pagingQuery;
			this._query(query, values, callback, function (results) {
				if (results) {
					var rows = [];
					results.forEach(function rowIterator(row) {
						rows.push(this.getInstanceFromRow(Model, row));
					}.bind(this));
					callback(null, new Collection(Model, rows));
				}
				else {
					callback();
				}
			}.bind(this));
		},
		save: function (Model, instance, callback) {
			var table = this.getTableName(Model),
				payload = instance.toPayload(),
				primaryKeyColumn = this.getPrimaryKeyColumn(Model),
				columns = this.escapeKeys(this.fetchColumns(table, payload)),
				placeholders = columns.map(function (name) { return name + ' = ?'; }),
				query = 'UPDATE ' + table + ' SET ' + placeholders.join(',') + ' WHERE ' + primaryKeyColumn + ' = ?';
			if (!primaryKeyColumn) {
				return callback(new Arrow.ORMError("can't find primary key column for " + table));
			}
			var values = _.values(payload).concat([instance.getPrimaryKey()]);

			this._query(query, values, callback, function (result) {
				if (result && result.affectedRows) {
					callback(null, instance);
				}
				else {
					callback();
				}
			}.bind(this));
		},
		'delete': function (Model, instance, callback) {
			var table = this.getTableName(Model),
				primaryKeyColumn = this.getPrimaryKeyColumn(Model),
				query = 'DELETE FROM ' + table + ' WHERE ' + primaryKeyColumn + ' = ?';
			if (!primaryKeyColumn) {
				return callback(new Arrow.ORMError("can't find primary key column for " + table));
			}
			this._query(query, instance.getPrimaryKey(), callback, function (result) {
				if (result && result.affectedRows) {
					callback(null, instance);
				}
				else {
					callback();
				}
			}.bind(this));
		},
		deleteAll: function (Model, callback) {
			var table = this.getTableName(Model),
				primaryKeyColumn = this.getPrimaryKeyColumn(Model),
				query = 'DELETE FROM ' + table;
			if (!primaryKeyColumn) {
				return callback(new Arrow.ORMError("can't find primary key column for " + table));
			}
			this._query(query, callback, function (result) {
				if (result && result.affectedRows) {
					callback(null, result.affectedRows);
				}
				else {
					callback();
				}
			}.bind(this));
		},

		/*
		 Utilities only used for this connector.
		 */
		fetchColumns: function fetchColumns(table, payload) {
			if (this.schema.objects[table]) {
				return _.intersection(Object.keys(payload), Object.keys(this.schema.objects[table]));
			}
			return Object.keys(payload);
		},
		getConnection: function getConnection(callback) {
			if (this.pool) {
				this.pool.getConnection(function pooledGetConnection(err, connection) {
					callback(err, connection);
				});
			}
			else {
				callback(null, this.connection);
			}
		},
		getTableName: function getTableName(Model) {
			var parent = Model;
			while (parent._parent && parent._parent.name) {
				parent = parent._parent;
			}
			var table = Model.getMeta('table') || parent.name || Model._supermodel || Model.name;
			if (table.indexOf(pkginfo.name + '/') >= 0) {
				table = table.replace(pkginfo.name + '/', '');
			}
			return table;
		},
		getPrimaryKeyColumn: function getPrimaryKeyColumn(Model) {
			var pk = Model.getMeta('primarykey');
			if (pk) {
				return pk;
			}
			var name = this.getTableName(Model),
				tableSchema = this.getTableSchema(Model),
				primaryKeyColumn = this.metadata.schema.primary_keys[name],
				column = primaryKeyColumn && tableSchema && tableSchema[primaryKeyColumn];

			return column && column.COLUMN_NAME;
		},
		getTableSchema: function getTableSchema(Model) {
			var name = this.getTableName(Model);
			return this.metadata.schema.objects[name];
		},
		getInstanceFromRow: function (Model, row) {
			var primaryKeyColumn = this.getPrimaryKeyColumn(Model),
				instance = Model.instance(row, true);
			if (primaryKeyColumn) {
				instance.setPrimaryKey(row[primaryKeyColumn]);
			}
			return instance;
		},
		convertDataTypeToJSType: function convertDataTypeToJSType(dataType) {
			switch (dataType) {
				case 'tinyint':
				case 'smallint':
				case 'mediumint':
				case 'bigint':
				case 'int':
				case 'integer':
				case 'float':
				case 'bit':
				case 'double':
				case 'binary':
					return Number;
				case 'date':
				case 'datetime':
				case 'time':
				case 'year':
					return Date;
				default:
					return String;
			}
		},
		/**
		 * Escape array of keys
		 * @param {Array} keys
		 * @return {Array}
		 */
		escapeKeys: function(keys) {
			return keys.map(function(item) {
				return '`' + item + '`';
			});
		},
		_query: function (query, data, callback, executor) {
			if (arguments.length < 4) {
				executor = callback;
				callback = data;
				data = null;
			}
			var pool = this.pool,
				logger = this.logger;
			logger.trace('MYSQL QUERY=>', query, data);
			this.getConnection(function (err, connection) {
				if (err) { return callback(err); }
				connection.query(query, data, function (err, results) {
					if (pool) {
						try {
							logger.trace('connection released back to the pool');
							connection.release();
						}
						catch (E) { }
					}
					if (err) {
						callback(err);
					}
					else {
						executor(results);
					}
				});
			});
		}

	});

};
