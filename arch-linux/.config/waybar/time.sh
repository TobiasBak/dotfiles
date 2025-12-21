#!/usr/bin/env sh

date=$(date +'%a %b %d')
if [ $(date +%Z) != "CEST" ]; then
  prague="$(TZ=Europe/Copenhagen date +'%-H:%M %Z') "
fi
#local=$(date +"%-H:%M %Z")
echo "$prague"
