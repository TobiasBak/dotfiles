#!/usr/bin/env sh

date=$(date +'%a %b %d')
if [ $(date +%Z) != "CEST" ]; then
  prague="$(TZ=Europe/Copenhagen date) "
fi
#local=$(date +"%-H:%M %Z")
echo "$date"
