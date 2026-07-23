# Opalinx wire conformance corpus

The `vectors.json` file is the canonical, machine-readable set of Opalinx 1.x wire
examples. Implementations consume this file in their automated tests; examples
must not be copied into implementation repositories.

`protocol_version` identifies the full Semantic Version of the specification release. The INFO
vectors carry only its three-byte `major.minor.patch` core because prerelease and build metadata are
not encoded on the wire.

Hex strings use lowercase, contain no separators, and represent bytes in wire
order. A valid-frame entry contains all three views of the same message:

- `payload_hex`: the message payload only;
- `decoded_hex`: the frame after COBS decoding, including its header and CRC;
- `wire_hex`: the COBS-encoded frame including the final `00` delimiter.

Invalid decoded-frame entries list every safe diagnostic category accepted for that malformed input.
An implementation must reject the input, but host check order and local diagnostic precedence are
not wire-visible. Stream entries describe chunk boundaries and the ordered outcomes produced by a
streaming decoder. Diagnostic names are stable corpus vocabulary rather than exact exception text
required of an implementation.

Changes to existing vectors are protocol changes. Additive vectors may clarify
already-specified behavior, but they must be reviewed against every maintained
implementation. CI consumers should pin an exact `opalinx-spec` commit.

The `schema.json` file defines the corpus format. It uses JSON Schema draft 2020-12.
