# T3 MCP

T3 MCP connects MCP hosts to T3 Code environments so users can run turns and read their results.

## Language

**MCP host**:
The application through which a user or bot invokes the connector's tools.
_Avoid_: Controller bot, primary bot

**Environment**:
A T3 Code server with its own identity, authorization, projects, and threads.
_Avoid_: Account, host

**Direct pairing**:
Authorization granted by an environment to a client without requiring T3 Connect.
_Avoid_: Cloud login

**Pairing grant**:
An environment-issued credential that authorizes establishing a session with specified permissions.
_Avoid_: Session, API key

**Environment session**:
The client's authenticated access to one environment, subject to that environment's permissions, expiry, and revocation.
_Avoid_: Pairing grant, Connect login

**T3 Connect**:
An optional service for access to remote environments, distinct from an environment's authorization.
_Avoid_: Required login

**Project**:
An organizational grouping within an environment associated with development work.
_Avoid_: Filesystem sandbox

**Thread**:
A conversation within an environment and project that contains turns and their recorded activity.
_Avoid_: Turn, session

**Turn**:
One submitted request and its ensuing agent work within a thread.
_Avoid_: Thread, job

**Continuation**:
A new turn submitted to an existing thread.
_Avoid_: Retry, resume transport
