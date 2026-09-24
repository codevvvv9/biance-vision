-- Runs on first-time volume initialization only.
-- Creates the non-superuser application role.
CREATE ROLE biance_app LOGIN PASSWORD 'biance_app';
ALTER DATABASE biance_vision OWNER TO biance_app;
