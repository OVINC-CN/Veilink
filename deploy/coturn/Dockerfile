FROM coturn/coturn:4.14.0-r0

USER root

# The upstream turnserver binary carries a file capability. Combining that
# binary with no-new-privileges and cap_drop=ALL makes Linux reject execve with
# EPERM (container exit 126). A plain copy intentionally drops the xattr while
# keeping the hardened runtime sandbox; port 3478 does not require privileges.
RUN cp /usr/bin/turnserver /usr/local/bin/veilink-turnserver \
    && chown root:root /usr/local/bin/veilink-turnserver \
    && chmod 0555 /usr/local/bin/veilink-turnserver

COPY --chmod=0555 deploy/coturn/entrypoint.sh /usr/local/bin/veilink-turn-entrypoint
COPY --chmod=0444 deploy/coturn/turnserver.conf.template /etc/coturn/veilink.conf.template

USER nobody:nogroup

ENTRYPOINT ["/bin/sh", "/usr/local/bin/veilink-turn-entrypoint"]
