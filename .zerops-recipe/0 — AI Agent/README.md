<!-- #ZEROPS_EXTRACT_START:intro# -->
The development topology Tep was built on: dev + stage pairs of api, worker and web
over single-node stores. The dev containers start empty for an AI agent (or you) to
adopt and drive — edit on the mounted filesystem, run dev servers via the agent —
while the stage pair builds from git as a live reference. Non-HA and lightweight.
<!-- #ZEROPS_EXTRACT_END:intro# -->
