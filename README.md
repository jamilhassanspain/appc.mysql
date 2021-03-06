# MySQL Connector

This is an Arrow connector to MySQL.

## Installation

```bash
$ appc install connector/appc.mysql --save
```

A configuration file is generated for you. By default we use a host of `localhost`, a user of `root` and an
empty password to connect. However, you must set a database in your configuration.

## Usage

Reference the connector in your model.

```javascript
var Account = Arrow.Model.extend('Account',{
	fields: {
		Name: { type: String, required: true, validator: /[a-zA-Z]{3,}/ }
	},
	connector: 'appc.mysql'
});
```

If you want to map a specific model to a specific table, use metadata.  For example, to map the `account` model to 
the table named `accounts`, set it such as:

```javascript
var Account = Arrow.Model.extend('account',{
	fields: {
		Name: { type: String, required: false, validator: /[a-zA-Z]{3,}/ }
	},
	connector: 'appc.mysql',
	metadata: {
		'appc.mysql': {
			table: 'accounts'
		}
	}
});
```

## Development

> This section is for individuals developing the MySQL Connector and not intended
  for end-users.

```bash
npm install
node app.js
```

### Running Unit Tests

To use the tests, you'll want to create a database with the following tables:

```
CREATE TABLE post
(
	id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
	title VARCHAR(255),
	content VARCHAR(255)
);
CREATE TABLE super_post
(
	id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
	title VARCHAR(255),
	content VARCHAR(255)
);
CREATE TABLE employee
(
	id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
	first_name VARCHAR(255),
	last_name VARCHAR(255),
	email_address VARCHAR(255)
);
```

```bash
npm test
```


# Contributing

This project is open source and licensed under the [Apache Public License (version 2)](http://www.apache.org/licenses/LICENSE-2.0).  Please consider forking this project to improve, enhance or fix issues. If you feel like the community will benefit from your fork, please open a pull request. 

To protect the interests of the contributors, Appcelerator, customers and end users we require contributors to sign a Contributors License Agreement (CLA) before we pull the changes into the main repository. Our CLA is simple and straightforward - it requires that the contributions you make to any Appcelerator open source project are properly licensed and that you have the legal authority to make those changes. This helps us significantly reduce future legal risk for everyone involved. It is easy, helps everyone, takes only a few minutes, and only needs to be completed once. 

[You can digitally sign the CLA](http://bit.ly/app_cla) online. Please indicate your email address in your first pull request so that we can make sure that will locate your CLA.  Once you've submitted it, you no longer need to send one for subsequent submissions.



# Legal Stuff

Appcelerator is a registered trademark of Appcelerator, Inc. Arrow and associated marks are trademarks of Appcelerator. All other marks are intellectual property of their respective owners. Please see the LEGAL information about using our trademarks, privacy policy, terms of usage and other legal information at [http://www.appcelerator.com/legal](http://www.appcelerator.com/legal).
