Collaborative Text Editor with X OAuth Authentication

- Durable objects based on path segments
- X OAuth for write permissions
- SQLite storage for persistence

Icons: https://github.com/microsoft/vscode-icons/tree/main/icons/dark

The first version still had lot of bugs. Finally, it became a lot easier after:

- moving to typescript
- putting all logic inside of the durable object to just have a single fetch handler where everything happens, rather than several.

License: MIT

By Jan Wilmake. [Discuss](https://x.com/janwilmake/status/1930894240403382433)
