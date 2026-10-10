# Populated BASE4e v4 migration fixture

This checked-in SQLite file was created by running the API and version-store implementation at commit `4e28839ea8baeb4112a4f12340ef2fe84f5c8efe`. It contains completed offline fixture generation and edit actions, a separately metered inspection action, both immutable versions, telemetry evidence, selection state, and the content-addressed artifact object. The fixture uses only the repository's `fixture-provider`; it contains no live provider calls or credentials.

`manifest.json` pins the database, request set, artifact bytes, and source commit. The current-version migration test opens this exact v4 database, verifies its pre-migration shape, migrates it to v6, closes and reopens it, and replays all three historical requests without reserving, redispatching, or reinspecting.
