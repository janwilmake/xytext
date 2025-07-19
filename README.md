Collaborative Text Editor with X OAuth Authentication

- Durable objects based on path segments
- X OAuth for write permissions
- SQLite storage for persistence

Every user gets their own Database with SQLite API: `GET /exec?query=SELECT%20path%20FROM%20nodes[&binding=1&binding=2]`. In the browser cookies ensure the user will be authenticated for this; over API the Authorization Bearer token must match the users API key.

License: MIT

By Jan Wilmake. [Discuss](https://x.com/janwilmake/status/1930894240403382433)
