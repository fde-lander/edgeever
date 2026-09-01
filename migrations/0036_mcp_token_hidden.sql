PRAGMA foreign_keys = ON;

CREATE TABLE mcp_token_hidden_notebooks (
  token_id     TEXT NOT NULL,
  notebook_id  TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (token_id, notebook_id),
  FOREIGN KEY (token_id)    REFERENCES api_tokens(id)    ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id)     ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX idx_mcp_token_hidden_ws
  ON mcp_token_hidden_notebooks(workspace_id);
