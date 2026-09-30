# T3 MCP

The current design interview confirms direct pairing, environment session, T3 Connect, Connect login, registered environment, Connect sign-out, and environment unregistration below. Other definitions from the prior pass remain draft.

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
An optional service for discovering and reaching remote environments, distinct from an environment's authorization.
_Avoid_: Required login

**Connect login**:
An operator's authenticated access to T3 Connect. It is not an environment session and does not itself authorize orchestration in an environment.
_Avoid_: Environment session, direct pairing

**Registered environment**:
An environment explicitly selected by the operator for use through the connector, retaining one stable registration across direct and Connect access when upstream identity proves it is the same environment. Discovery through Connect alone does not make an environment a turn target.
_Avoid_: Discovered environment

**Connect sign-out**:
Ending the connector's Connect login without removing registrations or revoking environment sessions. Valid environment sessions remain usable where the environment is reachable.
_Avoid_: Environment unregistration, environment session revocation

**Environment unregistration**:
Explicit removal of a saved environment registration and its locally retained access.
_Avoid_: Connect sign-out, upstream session revocation

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
