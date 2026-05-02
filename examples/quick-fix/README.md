# Quick Fix Example

This is a copy-paste starter project for a small implementation pipeline.

Run it from a project where Lattice is installed, then ask OpenCode:

```text
/quick-fix fix the failing checkout total test
```

The pipeline plans, pauses for approval, implements, and then reviews the change. The reviewer can signal `pass`, `fail`, or `blocked`; use `/lattice retry` after a failure to return to the implementation stage.
