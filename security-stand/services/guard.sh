#!/bin/sh
set -eu
iptables -P OUTPUT DROP
iptables -A OUTPUT -d 127.0.0.11 -j DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p tcp -d 172.30.91.2 --dport 8080 -j ACCEPT
iptables -A OUTPUT -p tcp -d 172.30.91.3 --dport 8080 -j ACCEPT
ip6tables -P OUTPUT DROP
ip6tables -A OUTPUT -o lo -j ACCEPT
touch /tmp/ready
exec sleep infinity
