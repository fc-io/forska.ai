# TODO

- Improve comparison serving materialization progress so long-running phases persist staged row/cell counts after each batch, not only when a phase completes. This should make the UI show real progress instead of `waiting for first staged rows` while rows are already being inserted.
