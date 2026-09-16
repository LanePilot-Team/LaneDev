# Bundled web asset provenance

- Source repository: LanePilot-Team/LaneDev
- Original source commit: `64a1fd8`
- Client source: `web-source/` in this same Git working directory
- Build: `npm run build` (relative Vite base + client packaging checks)
- Client revision date: 2026-09-07 (Asia/Taipei)
- Android assets: `app/src/main/assets/public`
- JavaScript checksums: generated `client-policy.json`

Official road and waiting-zone data retain the original APK bytes. Only transport
POIs/datasets and client UI/code are changed. Editor, simulation and transit modules
must not appear in the built module graph.
