#!/bin/sh

sleep 5

if ! temporal operator search-attribute list | grep -w MirrorName >/dev/null 2>&1; then
    temporal operator search-attribute create --name MirrorName --type Text --namespace default
fi

tini -s -- sleep infinity
