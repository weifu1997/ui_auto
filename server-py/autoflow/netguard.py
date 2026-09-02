"""Outbound browser navigation guard (P1-1 SSRF).

Browser navigation (run steps, element validation, recording start, preview) is
confined to the environment ``baseUrl`` origin by each caller. The residual
hole is that ``baseUrl`` is member-controlled and may itself point at
link-local / cloud-metadata space, so a caller with ``run.execute`` or recorder
access could steer the deployment box's headed browser at
``http://169.254.169.254/latest/meta-data/`` and read instance IAM credentials
— SSRF from a low-trust caller.

This module is the single source of truth for which hosts a browser may be
sent to. The scope is deliberately narrow (user-approved): cut IPv4 link-local
(169.254.0.0/16, incl. cloud metadata 169.254.169.254), IPv6 link-local
(fe80::/10), and the well-known metadata FQDNs. Loopback and RFC1918 private
space stay allowed because deployments legitimately automate against
127.0.0.1 / LAN apps (the recorder records a local demo, runs target internal
UIs), so those are not blanket-blocked.
"""

from __future__ import annotations

import ipaddress

_LINK_LOCAL_IPV4 = ipaddress.ip_network("169.254.0.0/16")
_METADATA_FQDNS = frozenset(
    {
        "metadata.google.internal",
        "metadata.azure.internal",
        "metadata.azure.com",
    }
)


def is_link_local_or_metadata_host(host: str | None) -> bool:
    """True if a base-URL host must not be a browser navigation target.

    ``host`` is the hostname from ``urlsplit(url).hostname`` (no brackets, no
    port, already lowercased by urllib). Returns False for empty values and for
    any host that is not a literal link-local/metadata address — hostnames that
    would only *resolve* to such space are out of scope for this deterministic
    guard (no DNS in the egress path).
    """
    if not host:
        return False
    host = host.strip("[]").rstrip(".").lower()
    if host in _METADATA_FQDNS:
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if ip.version == 4:
        return ip in _LINK_LOCAL_IPV4
    return ip.is_link_local
