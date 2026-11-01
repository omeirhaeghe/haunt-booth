#!/bin/bash
# Double-click on a Mac to start Haunt Booth. Runs the setup wizard the first time.
cd "$(dirname "$0")"
[ -f .env ] || node setup.js
node server.js
