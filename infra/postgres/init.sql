-- One Postgres instance, one database per service.
-- Each service only ever connects to its own database: no cross-service joins,
-- which is the whole point of "database per service".
CREATE DATABASE users_db;
CREATE DATABASE orders_db;
CREATE DATABASE inventory_db;
CREATE DATABASE notifications_db;
