# Host-independent MCP contract

The product is an open-source MCP connector with one generic `t3-run-turn` skill, usable by any compatible MCP host. MCP tools own environment registration, project discovery, turn submission, and thread retrieval; personal bot conventions and local `t3-turn` executables are not dependencies because they would couple adoption to a particular host setup.

## Consequences

The MVP exposes `add_environment`, `list_environments`, `list_projects`, `start_turn`, `continue_turn`, and `get_thread`. Host installation instructions may differ, but tool semantics and the shipped skill do not. After adoption, bot turns use MCP; local CLIs are optional debugging utilities.
