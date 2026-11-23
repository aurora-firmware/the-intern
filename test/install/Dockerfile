FROM debian:bookworm

ENV container=docker
RUN apt-get update \
    && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session curl ca-certificates sudo \
    && rm -rf /var/lib/apt/lists/*

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
