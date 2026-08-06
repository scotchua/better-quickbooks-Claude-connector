Optional screenshots for the docs.

README Step 9 used to depend on a `tool-permissions.png` here. It no longer
does: the recommended settings are a table in the README, which renders
everywhere, stays readable on a phone, works with a screen reader, and does not
go stale when the Claude Desktop settings UI is restyled.

If you want a screenshot as visual orientation, add it above that table rather
than in place of it. Capture Settings, then Connectors, then the `qbo`
connector's Tool permissions panel, and check nothing client-identifying is in
frame before committing it to a public repo.
