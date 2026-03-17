#!/bin/sh
cd ~/hermes && git pull && (cd server && npm install) && (cd app && npm install --include=dev && npm run build) && sudo systemctl restart hermes
