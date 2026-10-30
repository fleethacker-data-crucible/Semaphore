# Development branch reconciliation

2026-10-30

`armp/semaphore-0.3.0` (closed PR #10) is superseded by the application reconciliation in merged PR #17. The current README explicitly records that incorporation. The current core retains the original in-memory engine, flags, crossfilter, profiles and playbook, then extends them with joins, cleaning, experiment-page rules and Fairlead integration. Keep the current source, server security, package metadata, UI and guides. The merge records the old branch ancestry without rolling back these additions.
