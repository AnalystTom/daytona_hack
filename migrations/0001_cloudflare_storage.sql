CREATE TABLE run (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE event (
  run_id TEXT NOT NULL REFERENCES run(id), event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL, envelope TEXT NOT NULL CHECK(json_valid(envelope)),
  PRIMARY KEY(run_id, event_id), UNIQUE(run_id, sequence)
);
CREATE TABLE task (run_id TEXT NOT NULL REFERENCES run(id), task_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id, task_id));
CREATE TRIGGER event_task AFTER INSERT ON event
WHEN json_extract(NEW.envelope, '$.taskId') IS NOT NULL
BEGIN
  INSERT INTO task(run_id, task_id, data) VALUES (
    NEW.run_id, json_extract(NEW.envelope, '$.taskId'),
    json_object('taskId', json_extract(NEW.envelope, '$.taskId'),
      'state', json_extract(NEW.envelope, '$.state'),
      'updatedAt', json_extract(NEW.envelope, '$.timestamp'), 'lastEventId', NEW.event_id)
  ) ON CONFLICT(run_id, task_id) DO UPDATE SET data=excluded.data;
END;
CREATE TABLE steering (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run(id), data TEXT NOT NULL);
CREATE TABLE approval (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run(id), data TEXT NOT NULL);
CREATE TABLE memory (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run(id), kind TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX memory_run ON memory(run_id, created_at, id);
CREATE TABLE run_owner (run_id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, busy INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE INDEX run_owner_owner ON run_owner(owner, created_at DESC);
CREATE TABLE run_quota (scope TEXT NOT NULL, day TEXT NOT NULL, runs INTEGER NOT NULL, PRIMARY KEY(scope, day));
-- Used only inside one atomic admission batch; its final statement removes the row.
CREATE TABLE admission (id TEXT PRIMARY KEY, refusal TEXT);
CREATE TABLE evidence (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, record TEXT NOT NULL, blob_key TEXT NOT NULL);
CREATE INDEX evidence_run ON evidence(run_id);
CREATE TABLE sign_in (run_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE example (key TEXT PRIMARY KEY, value TEXT, blob_key TEXT);
CREATE TABLE report_run (run_id TEXT PRIMARY KEY, target TEXT NOT NULL, completed_at TEXT NOT NULL, snapshot_key TEXT NOT NULL);
CREATE TABLE report_figure (run_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, original TEXT NOT NULL, PRIMARY KEY(run_id, id));
CREATE TABLE report_source (run_id TEXT NOT NULL, id TEXT NOT NULL, original TEXT NOT NULL, PRIMARY KEY(run_id, id));
CREATE TABLE report_edit (run_id TEXT NOT NULL, figure_id TEXT NOT NULL, label TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(run_id, figure_id));
CREATE TABLE agent_memory (id TEXT PRIMARY KEY, scope TEXT NOT NULL, text TEXT NOT NULL, observed_at TEXT NOT NULL);
CREATE INDEX agent_memory_scope ON agent_memory(scope, observed_at DESC);
