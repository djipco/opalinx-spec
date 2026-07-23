# Opalinx Protocol Specification
### Version: 1.0.0 (Draft)

> [!WARNING]
> **Opalinx 1.0 is a Draft.** The `1.0.0` number is the target wire contract, but the specification is
> still being stabilized and breaking changes may occur before it is frozen. Implementations remain
> pre-1.0 until then; see [`../VERSIONING.md`](../VERSIONING.md) for how the protocol, firmware, and
> library versions relate.

**Opalinx** is a lightweight binary protocol that allows interfacing with compatible LED controllers
over a reliable byte stream (typically, serial over USB).


## Scope

**Opalinx** targets one-wire, addressable-LED chips in the **WS281x** family, including **WS2811**,
**WS2812**, **WS2812B**, **WS2813**, and their variants (e.g., **WS2814**, **WS2815**, **SK6812**).
Both 3-component (RGB) and 4-component (RGBW) chips are supported.

> [!NOTE]
> Two-wire protocols such as **APA102** (DotStar) and **WS2801** are not currently in scope for
> this specification.

**Opalinx** assumes a trusted, single-client transport binding that presents a reliable, ordered byte
stream. The core protocol does not define retransmission, duplicate suppression, network addressing,
authentication, or fixture personality modeling. Packet and unreliable transports require a
separate binding and are not core Opalinx 1.0 transports.


## Conventions

- **Key words**: **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used as
  defined in [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

- **Byte order**: All multi-byte integer fields are little-endian.

- **Strings**: UTF-8 encoded with a length prefix, not null-terminated.

- **Reserved fields and bits**: Senders MUST set them to zero; receivers MUST ignore their
  contents.

- **Versioning**: Protocol-version compatibility follows the wire-specific rules in
  [Protocol Version Compatibility](#protocol-version-compatibility). Package and firmware release
  versions are independent of the protocol version.


## Protocol Version Compatibility

The three protocol-version bytes in `INFO` describe the wire protocol implemented by the device,
not its firmware release. A device implementing version `M.m.p` MUST implement the complete base
contract for major `M` through minor `m` plus any patch-level corrections through `p`.

### Major version

A different major version is potentially incompatible. A host MUST reject a device whose protocol
major it does not implement and MUST NOT send configuration, pixel, or control requests to it.

The first three payload bytes of the `INFO` response are a stable **compatibility preamble**—major,
minor, patch—in that order. A host MUST inspect these bytes before parsing the version-specific
remainder of `INFO`. If the major is unsupported, the host MUST stop parsing after the preamble and
report an unsupported-protocol error. This lets a future major change the remainder of `INFO`
without being misreported as a malformed response by an older host. An `INFO` payload shorter than
three bytes is malformed and has no usable version preamble.

### Minor version

Within one major version, a higher minor version is additive. It MAY introduce:

- new request and response identifiers in previously reserved ranges;
- new capability bits;
- new `INFO` TLVs;
- new enum values only where the original field definition requires receivers to tolerate unknown
  values.

A minor version MUST NOT change the meaning, size, validation order, state transition, or response
semantics of an existing message or field. It also MUST NOT make a previously optional capability
mandatory for base-major conformance.

Same-major endpoints interoperate using the base contract and the features they mutually understand.
A host MUST NOT infer support merely because the device reports a sufficiently high minor version;
it MUST also use the capability bit, extension record, message definition, or other feature signal
specified for that feature. A host MAY use a newer device with an older understood minor by ignoring
unknown capabilities and TLVs and by not sending unknown messages. A newer host MAY use an older
device but MUST disable features the older device does not advertise.

### Patch version

A patch version MUST NOT change any encoded layout, identifier assignment, accepted value, required
state transition, or other externally observable wire behavior. It is reserved for editorial
clarifications, corrected examples, conformance vectors, and implementation fixes that bring behavior
back to the already-published contract. Same-major compatibility decisions MUST ignore the patch
number.

### Draft revisions

The Draft warning at the top of this document takes precedence until Opalinx 1.0 is frozen: draft
implementations are developed as a coordinated set and the `1.0.0` tuple alone does not prove that
two builds came from the same draft revision. An incompatible draft edit MUST update all maintained
implementations and conformance vectors together. No independent implementation should claim stable
Opalinx 1.0 compatibility until the Draft marker is removed. Before that freeze, the project MUST either
stop making incompatible changes or introduce an explicit on-wire draft-revision discriminator.


## General Message Format

All **Opalinx** messages, whether sent by a host (request) or by a device (response), share the
following unencoded structure:

| TRANSACTION ID | MESSAGE IDENTIFIER   | PAYLOAD LENGTH | PAYLOAD  | CHECKSUM |
|----------------|----------------------|----------------|----------|----------|
| 2 bytes        | 1 byte               | 2 bytes        | variable | 2 bytes  |

**Opalinx** frames are encoded with
[Consistent Overhead Byte Stuffing (COBS)](https://en.wikipedia.org/wiki/Consistent_Overhead_Byte_Stuffing)
and terminated with a single `0x00` delimiter byte. The encoded frame is guaranteed not to contain
`0x00`. Receivers resynchronize at each delimiter and MUST bound the memory used to accumulate an
encoded frame.

### Receiver Framing and Recovery

A receiver has two byte-stream states:

- **Accumulating**: nonzero bytes are appended to the current encoded-frame buffer.
- **Discarding oversized frame**: bytes are discarded until the next `0x00` delimiter. No prefix of
  the oversized frame may be decoded or dispatched.

The receiver's maximum encoded-frame length MUST be large enough for a frame carrying its advertised
`max_payload_length`, including the seven decoded framing bytes and worst-case COBS overhead. If the
accumulation exceeds that limit before a delimiter arrives, the receiver MUST enter the discarding
state immediately and release or reuse the accumulated storage. This bounds memory even if a peer
never sends a delimiter.

On receipt of a delimiter, the receiver MUST behave as follows:

1. If it is discarding an oversized frame, it returns to the accumulating state. A device MUST emit
   exactly one `ERR_INVALID_PAYLOAD_LENGTH` for that discarded frame, using transaction ID `0x0000`
   and offending identifier `0x00`, because no field in an incomplete prefix is trustworthy.
2. If it is accumulating zero bytes, the delimiter is a lone delimiter and MUST be silently ignored.
3. Otherwise, the accumulated bytes form one candidate frame. The receiver clears its accumulation
   before processing the candidate so the next frame can be received independently.

A COBS-decoded frame has a minimum size of seven bytes: transaction ID (2), identifier (1), payload
length (2), and CRC (2). A device MUST emit `ERR_FRAMING_ERROR` with transaction ID `0x0000` and
offending identifier `0x00` if COBS decoding fails or produces fewer than seven bytes.

For a decoded frame of at least seven bytes, a device receiver MUST validate and reject in this exact
order:

1. **CRC**: The received checksum is always the final two decoded bytes. It MUST NOT be located using
   the untrusted payload-length field. Calculate the CRC over every preceding decoded byte. On
   mismatch, emit `ERR_CRC_MISMATCH` using the transaction ID and identifier recovered from byte
   positions 0–2, even if those recovered values were themselves corrupted.
2. **Identifier and direction**: A device accepts request identifiers `0x01`–`0x7F`. It MUST reject
   `0x00` and response-space identifiers `0x80`–`0xFF` with `ERR_UNKNOWN_IDENTIFIER`, echoing the
   recovered transaction ID and offending identifier.
3. **Declared payload length**: The decoded size MUST equal `7 + payload_length`. A mismatch MUST
   produce `ERR_INVALID_PAYLOAD_LENGTH`, echoing the recovered transaction ID and identifier.
4. **Receiver capacity**: A structurally valid payload exceeding the receiver's advertised
   `max_payload_length` MUST produce `ERR_INVALID_PAYLOAD_LENGTH`. In the usual bounded-buffer
   implementation this case is already handled by the oversized-frame discard rule above.
5. **Message-specific payload length**: A payload whose size differs from the exact size required by
   its recognized message identifier MUST produce `ERR_INVALID_PAYLOAD_LENGTH`.
6. **Parameter values and operational state**: Only after all preceding checks pass may the receiver
   validate field values or dispatch the request.

The oversized-frame rule is the only exception to CRC-first validation: the complete frame and its
checksum were never retained, so CRC validation is impossible. An oversized frame causes exactly one
uncorrelated error at its terminating delimiter and MUST NOT affect previously accepted protocol or
pixel state.

A host receiving malformed device output MUST apply the same framing boundaries and validation order,
discard the malformed candidate, and continue at the next delimiter. It reports the failure locally;
it MUST NOT send an `ERROR` response to a malformed response, which avoids error-response loops.

**Fields**:

 - **Transaction ID**: A 16-bit unsigned integer, little-endian, generated by the host for each
   request. The device MUST echo the same value in the corresponding response. `0x0000` is a
   reserved sentinel meaning "no correlation required"; hosts MAY use it for fire-and-forget
   requests, and devices MUST still echo it unchanged. Hosts that increment `TxID` sequentially
   MUST skip `0x0000` when wrapping, advancing from `0xFFFF` to `0x0001`. Hosts using
   `TxID = 0x0000` may receive `ERR_BUSY` responses that cannot be correlated to any pending
   request; such hosts SHOULD monitor for unsolicited `ERR_BUSY` responses if frame-drop detection
   is required.

 - **Identifier**: A single byte identifying the message. `0x00` and `0x80` are reserved and
   MUST NOT be used as message identifiers; `0x00` serves as the sentinel value for "unknown"
   in the `ERROR` response's offending identifier field, and `0x80` is its paired response-space
   counterpart. The high bit distinguishes request messages (host→device, `0x01`–`0x7F`) from
   response messages (device→host, `0x81`–`0xFF`).

 - **Payload length**: A 16-bit unsigned integer, little-endian, specifying the length of the
   payload in bytes. This field is always present, even for messages with an empty payload.

 - **Payload**: Message-specific data. May be empty for some messages.

 - **Checksum**: Two bytes, little-endian, containing a CRC-16/CCITT-FALSE over `transaction id` +
   `identifier` + `payload length` + `payload`.

**Frame size**: The protocol supports a maximum payload length of 65535 bytes (16-bit unsigned
integer). Every implementation MUST accept at least 8 payload bytes, enough for one RGB
`Set Pixels` operation (`5` addressing bytes + `3` component bytes). A device advertising
`CAP_RGBW` MUST accept at least 9 payload bytes so one RGBW pixel also fits. Implementations intended
for high-throughput streaming SHOULD accept at least 4101 payload bytes, sufficient for 1365 RGB or
1024 RGBW LEDs per `Set Pixels` message, but this is a performance recommendation rather than a
conformance requirement.

Each device advertises its actual buffer capacity in the `max_payload_length` field of the `INFO`
response. Clients MUST derive their chunk size from that field and MUST NOT send a payload exceeding
the advertised value. Because `Set Pixels` carries an LED offset, an arbitrarily long channel can be
updated through multiple messages without requiring the whole channel to fit in one payload. Devices
MUST reject frames exceeding their capacity with `ERR_INVALID_PAYLOAD_LENGTH`. After COBS encoding,
a frame grows by at most one byte per 254 bytes
of input plus the `0x00` delimiter. Receivers SHOULD size their read buffers for the worst-case
encoded length of the largest payload they intend to receive:

```
Transaction ID + Identifier + Payload Length + Payload + CRC + COBS Overhead + Delimiter
```

**CRC**:

The format used is **CRC-16/CCITT-FALSE** with the following parameters:

 - Polynomial: `0x1021`
 - Initial value: `0xFFFF`
 - No input reflection, no output reflection, no final XOR.

> [!NOTE]
> Implementations can verify their CRC by computing it over the ASCII string `"123456789"`, which
> MUST yield `0x29B1`.

Receivers MUST validate the CRC on every complete COBS-decoded candidate of at least seven bytes and
MUST reject a candidate with an invalid CRC using `ERR_CRC_MISMATCH`. Candidates that cannot be
decoded, are shorter than seven bytes, or were discarded as oversized follow the recovery rules in
[Receiver Framing and Recovery](#receiver-framing-and-recovery), because their CRC cannot be
reliably located or validated.


## Message Ranges

Messages are grouped by purpose. The high bit of the identifier byte distinguishes requests
(host→device) from responses (device→host).

### Requests (`0x00`–`0x7F`)

| Range           | Purpose                                                    |
|-----------------|------------------------------------------------------------|
| `0x00`          | Reserved (unknown identifier sentinel)                     |
| `0x01` – `0x0F` | Device queries (identity, configuration, status)           |
| `0x10` – `0x1F` | Reserved                                                   |
| `0x20` – `0x2F` | Device configuration                                       |
| `0x30` – `0x3F` | Reserved                                                   |
| `0x40` – `0x4F` | Pixel data operations                                      |
| `0x50` – `0x5F` | Control operations (show, reset)                           |
| `0x60` – `0x6F` | Reserved (mirrors `0xE0`–`0xEF`; MUST NOT be assigned)     |
| `0x70` – `0x7F` | Vendor-specific extensions                                 |

### Responses (`0x80`–`0xFF`)

| Range           | Purpose                                                    |
|-----------------|------------------------------------------------------------|
| `0x80`          | Reserved (paired sentinel for `0x00`)                      |
| `0x81` – `0x8F` | Query responses                                            |
| `0x90` – `0x9F` | Reserved                                                   |
| `0xA0` – `0xAF` | Device configuration responses                             |
| `0xB0` – `0xBF` | Reserved                                                   |
| `0xC0` – `0xCF` | Pixel data responses                                       |
| `0xD0` – `0xDF` | Control responses                                          |
| `0xE0` – `0xEF` | Errors                                                     |
| `0xF0` – `0xFF` | Vendor-specific responses                                  |

**Response pairing convention.** The success response identifier for a given request is the
request identifier with the high bit set: a request with identifier `0x01` is paired with a
response with identifier `0x81`. Error responses always use `ERROR` (`0xE0`) regardless of the
originating request.

**Opalinx** 1.0 assumes a reliable, ordered, single-client transport. Hosts correlate responses to
requests using the transaction ID echoed by the device.


## Channel Addressing Convention

Messages that operate on a single LED channel use a one-byte channel identifier with the following
convention:

- `0` through `N-1`: addresses the specified channel, where `N` is the number of channels
  reported by the device in its INFO response.
- `255`: broadcast. The message applies to all channels simultaneously.
- `N` through `254`: invalid. Implementations MUST reject messages specifying these values by
  emitting an `ERROR` response with code `ERR_INVALID_PARAMETER`.


## Request Messages

### Request Device Information (`0x01`)

Queries the device for its identity and protocol compatibility. Clients SHOULD send this as the
first message after connection establishment.

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | CHECKSUM |
|----------------|------------|----------------|----------|
| 2 bytes        | `0x01`     | `0x00` `0x00`  | 2 bytes  |

**Response**: [`INFO`](#info-0x81).

### Request Device Configuration (`0x02`)

Queries the device for its current configuration.

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | CHECKSUM |
|----------------|------------|----------------|----------|
| 2 bytes        | `0x02`     | `0x00` `0x00`  | 2 bytes  |

**Response**: [`CONFIG`](#config-0x82-0xa0) (`0x82`).

### Ping (`0x03`)

Checks that the device is present and responsive. Clients MAY send this at any time after
connection establishment to verify connectivity or measure round-trip latency.

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | CHECKSUM |
|----------------|------------|----------------|----------|
| 2 bytes        | `0x03`     | `0x00` `0x00`  | 2 bytes  |

**Response**: [`PONG`](#pong-0x83).

### Configure Device (`0x20`)

Sets the LED color order, signaling protocol, and LED count for one channel, or for all channels
simultaneously (broadcast). Clients SHOULD send this during initialization, before streaming any
pixel data.

| TX ID   | IDENTIFIER | PAYLOAD LENGTH | CHANNEL | COLOR ORDER | PROTOCOL | LED COUNT | CHECKSUM |
|---------|------------|----------------|---------|-------------|----------|-----------|----------|
| 2 bytes | `0x20`     | `0x05` `0x00`  | 1 byte  | 1 byte      | 1 byte   | 2 bytes   | 2 bytes  |

**Channel number**:

- `0` through `N-1`: configures the specified channel. Only supported by devices that advertise
  `CAP_PER_CHANNEL_CONFIG`; others MUST reject with `ERR_UNSUPPORTED`.
- `255`: broadcast. Applies the same configuration to all channels simultaneously.

Clients SHOULD check `CAP_PER_CHANNEL_CONFIG` before sending per-channel messages to avoid
unnecessary round-trips.

**Color Order values**:

| Value  | Order | Value  | Order | Value  | Order |
|--------|-------|--------|-------|--------|-------|
| `0x00` | RGB   | `0x0A` | BRGW  | `0x14` | GWRB  |
| `0x01` | RBG   | `0x0B` | BGRW  | `0x15` | GWBR  |
| `0x02` | GRB   | `0x0C` | WRGB  | `0x16` | BWRG  |
| `0x03` | GBR   | `0x0D` | WRBG  | `0x17` | BWGR  |
| `0x04` | BRG   | `0x0E` | WGRB  | `0x18` | RGWB  |
| `0x05` | BGR   | `0x0F` | WGBR  | `0x19` | RBWG  |
| `0x06` | RGBW  | `0x10` | WBRG  | `0x1A` | GRWB  |
| `0x07` | RBGW  | `0x11` | WBGR  | `0x1B` | GBWR  |
| `0x08` | GRBW  | `0x12` | RWGB  | `0x1C` | BRWG  |
| `0x09` | GBRW  | `0x13` | RWBG  | `0x1D` | BGWR  |

Values `0x00`–`0x05` are 3-component (RGB) and `0x06`–`0x1D` are 4-component (RGBW). All other
values are reserved and MUST be rejected with `ERR_INVALID_PARAMETER`. Devices that do not
advertise `CAP_RGBW` MUST reject 4-component color orders with `ERR_UNSUPPORTED`.

**Protocol values**: select the WS281x signaling protocol — the chip family and its bit timing.
(Named `protocol` rather than `speed` because the choice is a signaling variant, not merely a data
rate.)

| Value  | Protocol           |
|--------|--------------------|
| `0x00` | WS2811 at 800 kHz  |
| `0x01` | WS2811 at 400 kHz  |
| `0x02` | WS2813 at 800 kHz  |

All other values are reserved and MUST be rejected with `ERR_INVALID_PARAMETER`.

**LEDs on channel**: A 16-bit unsigned integer, little-endian. Devices MUST reject a value of
`0` or any value exceeding their capacity with `ERR_INVALID_PARAMETER`.

If `Configure Device` is not sent, implementations SHOULD default to GRB color order, the WS2811
800 kHz protocol, and a device-specific default LED count. On success, `Configure Device` MUST clear the
pixel buffer of every affected channel to all-zeros; hosts MUST NOT rely on buffer contents
surviving a reconfiguration. A broadcast `Configure Device` MUST be applied atomically: either all
channels are reconfigured and their buffers cleared, or no channel is modified.

**Response**: [`CONFIG`](#config-0x82-0xa0) (`0xA0`, confirming the applied configuration) or
[`ERROR`](#error-0xe0) if the requested configuration is not supported.

### Set Pixels (`0x40`)

Sets the color data for one channel or for all channels simultaneously (broadcast). Data is
buffered on the device; a [`Show`](#show-0x50) message is required to commit buffered data to the
LEDs.

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | PAYLOAD   | CHECKSUM |
|----------------|------------|----------------|-----------|----------|
| 2 bytes        | `0x40`     | 2 bytes        | see below | 2 bytes  |

**Payload structure**:

| Field          | Size     | Description                                                    |
|----------------|----------|----------------------------------------------------------------|
| Channel number | 1 byte   | Target channel; see channel number description below           |
| LED offset     | 2 bytes  | Starting LED index within the channel, little-endian           |
| LED count      | 2 bytes  | Number of LEDs covered by this message, little-endian          |
| Pixel data     | variable | `LED_count × bytes_per_LED`; see color bytes per LED below     |

**Channel number**:

- `0` through `N-1`: assigns color data to the specified channel.
- `255`: broadcast. Assigns the same color data to all channels simultaneously.

**Color bytes per LED**: Determined by the configured color order: 3 bytes for RGB-family orders,
4 bytes for RGBW-family orders. Each LED's bytes MUST be supplied in the channel's configured wire
order (the color order set by `Configure Device`); the device writes them to the strip unchanged and
never reorders them. Reordering from a logical layout is the host's responsibility. This keeps the
device free of per-pixel work on the streaming path.

**Payload length**: Equal to `1 + 2 + 2 + (LED_count × bytes_per_LED)`.

`Set Pixels` messages MUST satisfy all of the following; violations MUST be rejected with
`ERR_INVALID_PARAMETER`:

- `LED_count` MUST be greater than zero.
- `LED_offset` MUST be less than the configured number of LEDs on the target channel.
- `LED_offset + LED_count` MUST be less than or equal to the configured number of LEDs on the
  target channel.
- For broadcast pixel operations (`Channel number = 255`), all targeted channels MUST share
  compatible color orders, and each targeted channel's configured LED count MUST be at least
  `LED_offset + LED_count`; otherwise the message MUST be rejected.

Any rejected `Set Pixels` message MUST be rejected atomically with a single `ERROR` response; no
channel's buffer may be modified as a result of a rejected message.

**Response**: Emits [`SET_PIXELS_ACK`](#set_pixels_ack-0xc0) on success if `TxID ≠ 0x0000`; no
response if `TxID = 0x0000`. Emits [`ERROR`](#error-0xe0) on failure regardless of `TxID`. For
high-throughput streaming, `TxID = 0x0000` is recommended to avoid ACK overhead.

### Fill Channel (`0x41`)

Sets all LEDs on one channel, or all channels (broadcast), to a single uniform color. Data is
buffered; a [`Show`](#show-0x50) message is required to commit.

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | PAYLOAD   | CHECKSUM |
|----------------|------------|----------------|-----------|----------|
| 2 bytes        | `0x41`     | 2 bytes        | see below | 2 bytes  |

**Payload structure**:

| Field          | Size   | Description                                                            |
|----------------|--------|------------------------------------------------------------------------|
| Channel number | 1 byte | Target channel; see channel addressing convention                      |
| Color byte 1   | 1 byte | First component in the channel's configured wire order                 |
| Color byte 2   | 1 byte | Second component in the channel's configured wire order                |
| Color byte 3   | 1 byte | Third component in the channel's configured wire order                 |
| Color byte 4   | 1 byte | Fourth component in wire order; present only when channel is RGBW-configured |

The color is supplied in the channel's configured wire order — exactly as for
[`Set Pixels`](#set-pixels-0x40) — and the device writes it to every LED unchanged. The device never
reorders components; converting from a logical layout is the host's responsibility. For example, on a
`GRB` channel the three bytes are sent in G, R, B order.

**Payload length**: `4` for RGB-configured channels, `5` for RGBW-configured channels.

**Channel number**:

- `0` through `N-1`: Fills the specified channel.
- `255` (broadcast): Fills all channels simultaneously.

`Fill Channel` MUST be rejected with `ERR_INVALID_PARAMETER` if:

- The payload length does not match the expected size for the target channel's configured color
  order. *(This check is deferred to the parameter-validation stage because the expected length
  depends on the channel's configured color order, which is not known until the channel number is
  resolved. Violations are therefore reported as `ERR_INVALID_PARAMETER` rather than
  `ERR_INVALID_PAYLOAD_LENGTH`; this is an intentional exception to the general validation-order
  rule.)*
- For broadcast, any targeted channel's configured color order is not compatible with the supplied
  wire bytes. Because the same bytes are written verbatim to every channel, all targeted channels
  MUST share compatible color orders (not merely a matching component count).

Any rejected `Fill Channel` message MUST be rejected atomically; no channel's buffer may be
modified as a result of a rejected message.

`Fill Channel` can be used to turn channels off (all components set to `0`) or to apply test colors.

**Response**: Emits [`FILL_CHANNEL_ACK`](#fill_channel_ack-0xc1) on success if `TxID ≠ 0x0000`;
no response if `TxID = 0x0000`. Emits [`ERROR`](#error-0xe0) on failure regardless of `TxID`. For
high-throughput streaming, `TxID = 0x0000` is recommended to avoid ACK overhead.

### Show (`0x50`)

Commits buffered channel data (from `Set Pixels` and `Fill Channel`) to the physical LEDs. Can
target a single channel or commit all channels atomically.

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | PAYLOAD                  | CHECKSUM |
|----------------|------------|----------------|--------------------------|----------|
| 2 bytes        | `0x50`     | `0x01` `0x00`  | Channel number (1 byte)  | 2 bytes  |

**Channel number**:

- `0` through `N-1`: targeted channel number. Only supported by devices that advertise
  `CAP_PER_CHANNEL_SHOW`; others MUST reject with `ERR_UNSUPPORTED`. Clients SHOULD check
  `CAP_PER_CHANNEL_SHOW` before sending per-channel `Show` messages to avoid unnecessary
  round-trips.
- `255`: broadcast. Commits all channels simultaneously, guaranteeing synchronized multi-channel
  updates without inter-channel tearing. Devices MUST start all channel transmissions at the same
  time; this is a hardware conformance requirement.

**Buffer persistence**: Each channel's buffer is initialized to all-zeros at power-on and persists
across `Show` messages, being overwritten only by subsequent `Set Pixels` or `Fill Channel`
messages targeting that channel, or cleared by a successful `Configure Device`. This allows
channels to be updated at independent frame rates.

**Response**: Emits [`SHOW_ACK`](#show_ack-0xd0) after LED transmission completes if
`TxID ≠ 0x0000`; no response if `TxID = 0x0000`. Emits [`ERROR`](#error-0xe0) on failure
regardless of `TxID`. Hosts that use a non-zero `TxID` for `Show` and wait for `SHOW_ACK` before
issuing the next `Show` are guaranteed never to receive `ERR_BUSY`. For high-throughput streaming,
hosts MUST use acknowledged `Show` requests as described in [Frame Pipelining](#frame-pipelining).
`TxID = 0x0000` is suitable only when the host deliberately does not pipeline and does not require
completion or buffer-safety feedback.

### Frame Pipelining

Frame transmission on **WS281x** LEDs takes a fixed, comparatively long time. The duration for one
channel is:

```text
bits_per_led       = components_per_led × 8
data_time          = LED_count × bits_per_led × bit_period
frame_time         = data_time + reset_time
minimum_reset_time = 300 µs
```

The protocol values defined by Opalinx use a `1.25 µs` bit period at 800 kHz and a `2.5 µs` bit period
at 400 kHz. Therefore, excluding the reset interval, one RGB LED takes approximately `30 µs` at
800 kHz or `60 µs` at 400 kHz; one RGBW LED takes approximately `40 µs` at 800 kHz or `80 µs` at
400 kHz. For a broadcast `Show`, all channels start together and the physical operation completes
when the slowest affected channel completes, so its duration is the maximum `frame_time` across the
affected channels, not the sum of their durations.

A host that waits for `SHOW_ACK` before issuing the next `Show` (the lock-step pattern above) leaves
the device idle for one host round-trip at every frame boundary, because the device cannot begin the
next frame until a new `Show` arrives. Frame pipelining removes that idle gap by letting the host
queue the next `Show` while the current frame is still transmitting.

**Frame pipelining is a mandatory part of Opalinx.** Every conformant device supports a one-deep `Show`
queue, so a host can always pipeline without negotiating a capability first — pipelining is never
rejected and is never slower than lock-step. This universality is deliberate: it lets host libraries
keep the transmission pipe full by default rather than treating high throughput as an optional
extra.

In Opalinx 1.0 the pipeline depth is fixed at exactly `2`: one actively transmitting `Show` plus one
queued `Show`. This is part of the base protocol contract, not a negotiable device resource, so it is
not repeated in [`INFO`](#info-0x81). A host implementing Opalinx 1.0 always applies the state machine
below.

#### Future streaming models

A deeper queue cannot be created by changing a numeric limit: the baseline queued `Show` reserves
one staging-buffer generation and does not snapshot arbitrarily many future frames. Any future
advanced streaming model MUST therefore be advertised explicitly using a standard INFO extension
and capability assigned by that future specification, and MUST use separately assigned request and
response messages. Its definition must specify buffer ownership, frame boundaries, admission,
backpressure, completion, acknowledgement, and recovery semantics. It MUST NOT reinterpret or
change the behavior of the Opalinx 1.0 `Set Pixels`, `Fill Channel`, or `Show` messages.

This leaves the mandatory baseline usable without negotiation while allowing future devices to add
frame slots, buffer handles, bulk submission, compression, or deeper queues without complicating or
weakening the 1.0 state machine.

#### Pipeline buffer model

The state machine uses two logical storage roles:

- The **staging buffers** are modified by `Set Pixels` and `Fill Channel` and persist between frames.
- The **active snapshot** is the immutable data currently owned by the LED-output backend. Starting
  a transmission samples or otherwise commits the staging buffers into this role.

A queued `Show` is only a queue record containing its target and transaction ID. It does **not**
snapshot the staging buffers when accepted. The staging buffers become reserved for that queued
frame and are sampled only when the queued `Show` is promoted to active. An implementation may use
copying, buffer swapping, DMA ownership transfer, or another mechanism, provided its externally
visible behavior is identical.

#### Device states

The pipeline is global to the device, including on devices that support per-channel `Show`:

| State | Active transmission | Queued `Show` | Staging-buffer ownership |
|-------|---------------------|---------------|--------------------------|
| `IDLE` | No | No | Free for pixel writes |
| `ACTIVE` | Yes | No | Free for preparation of the next frame |
| `ACTIVE_QUEUED` | Yes | Yes | Reserved for the queued frame |

The physical LED reset/latch interval is part of the active transmission. The device remains in
`ACTIVE` or `ACTIVE_QUEUED` until both pixel transmission and the required reset interval complete.
An internal scheduling delay between accepting a `Show` in `IDLE` and starting hardware output MUST
NOT be externally observable: the staging buffers must be sampled before the device processes a
later request that could modify them.

After validating the complete request, the device MUST apply this admission table. A rejection does
not change pipeline or buffer state.

| Request | `IDLE` | `ACTIVE` | `ACTIVE_QUEUED` |
|---------|--------|----------|-----------------|
| `Set Pixels`, `Fill Channel` | Accept | Accept into staging | `ERR_BUSY` |
| `Show` | Sample staging and enter `ACTIVE` | Queue and enter `ACTIVE_QUEUED` | `ERR_BUSY` |
| `Configure Device` | Accept | `ERR_BUSY` | `ERR_BUSY` |
| `Reset` | Accept | `ERR_BUSY` | `ERR_BUSY` |
| Query and `Ping` requests | Accept | Accept | Accept |

The table applies after message-specific length, parameter, capability, and device-operational checks.
For example, an invalid channel still produces `ERR_INVALID_PARAMETER` rather than `ERR_BUSY`.
Vendor requests define their own state admission rules.

#### Completion, promotion, and acknowledgements

When an active frame finishes, the device MUST perform the following transition atomically with
respect to request processing:

- From `ACTIVE`: release the active snapshot, enter `IDLE`, then emit `SHOW_ACK` for the completed
  `Show` if its transaction ID is nonzero.
- From `ACTIVE_QUEUED`: sample the reserved staging buffers, start the queued `Show`, clear the queue
  record, enter `ACTIVE`, and only then emit `SHOW_ACK` for the frame that just completed if its
  transaction ID is nonzero.

Every `SHOW_ACK(TxID=N)` proves that the `Show` carrying transaction ID `N` has completed its physical
LED transmission and reset interval. If a successor was queued behind that frame, the same
acknowledgement additionally proves that the successor has been sampled into the active snapshot and
the staging buffers are free for reuse. It does not acknowledge completion of the successor; that
successor receives its own `SHOW_ACK` after it finishes. Responses are therefore emitted in accepted
`Show` order.

#### Host discipline

A pipelining host MUST use a nonzero transaction ID for every `Show`; it MUST be distinct from every
other outstanding transaction ID. The host keeps no more than two `Show` operations outstanding:
one active and one queued. The steady-state sequence is:

1. Prepare frame *N* in staging and send `Show(N)`.
2. While frame *N* is active, prepare frame *N+1* and send `Show(N+1)`, reserving staging.
3. Do not send pixel writes for frame *N+2* until `SHOW_ACK(N)` arrives.
4. On `SHOW_ACK(N)`, frame *N+1* is active and staging is free; prepare frame *N+2* and continue.

Pixel traffic may remain fire-and-forget with `TxID = 0x0000`; the acknowledged `Show` is the single
per-frame pacing and buffer-safety signal. A host MUST stop submitting later-frame data whenever two
`Show` operations are outstanding. The final frame is drained by waiting for its own `SHOW_ACK`,
which proves that no transmission or queued frame remains.

### Reset (`0x51`)

Resets the device to its power-on state: clears all channel buffers to zero, restores all channel
configurations to their defaults, and outputs zeros to the physical LEDs. Clients MAY send this
to establish a known state after connection or after an error condition.

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | CHECKSUM |
|----------------|------------|----------------|----------|
| 2 bytes        | `0x51`     | `0x00` `0x00`  | 2 bytes  |

**Response**: [`RESET_ACK`](#reset_ack-0xd1) after LED transmission completes, or
[`ERROR`](#error-0xe0) on failure. `RESET_ACK` is always sent regardless of `TxID`; `Reset` is
a management command, not a streaming operation. The `RESET_ACK` response carries the echoed
transaction ID, including `0x0000` if the request was sent with `TxID = 0x0000`.

## Response Messages

### INFO (`0x81`)

Sent in response to [`Request Device Information`](#request-device-information-0x01).

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | PAYLOAD   | CHECKSUM |
|----------------|------------|----------------|-----------|----------|
| 2 bytes        | `0x81`     | 2 bytes        | see below | 2 bytes  |

**Payload structure**:

| Field                   | Size     | Description                                                 |
|-------------------------|----------|-------------------------------------------------------------|
| Protocol version major  | 1 byte   | Major version of the **Opalinx** protocol                      |
| Protocol version minor  | 1 byte   | Minor version of the **Opalinx** protocol                      |
| Protocol version patch  | 1 byte   | Patch version of the **Opalinx** protocol                      |
| Channel count           | 1 byte   | Number of LED channels (`N`) supported by the device        |
| Capability flags        | 4 bytes  | Bitfield, little-endian; see capability bits below          |
| Max payload length      | 2 bytes  | Max accepted payload, little-endian; MUST be ≥ 8, or ≥ 9 with `CAP_RGBW` |
| Max LEDs (RGB)          | 2 bytes  | Max LEDs per channel in a 3-component order, little-endian; `0` = not advertised |
| Max LEDs (RGBW)         | 2 bytes  | Max LEDs per channel in a 4-component order, little-endian; `0` = not advertised |
| Information records     | variable | TLV records containing identity and extension information   |

`max_leds_rgb` and `max_leds_rgbw` report the largest LED count the device accepts for one channel
configured with a 3-component or 4-component color order, respectively. These limits are not
derivable from `max_payload_length`: a device can buffer a full channel across multiple
`Set Pixels` messages, so its channel capacity can exceed the number of pixels carried by one
payload. A value of `0` means that the device does not advertise a limit for that component count.
Hosts MUST NOT infer a channel limit from `max_payload_length`; when the corresponding advertised
limit is zero, a host SHOULD attempt the desired `Configure Device` request and handle
`ERR_INVALID_PARAMETER` if the count exceeds the device's capacity.

The fixed prefix is exactly 14 bytes. It contains only fields needed for wire compatibility,
addressing, and resource planning. Firmware identity and descriptive strings are information records
so future metadata does not enlarge or reorder the compatibility prefix.

`hardware_revision`, `hardware_platform`, and `transport` records are mandatory, non-empty UTF-8
strings of at most 63 bytes.
When a device cannot determine its hardware revision, it MUST report `unknown`. The hardware
revision is manufacturer-defined; examples include `Rev A`, `1.2`, and `unknown`.

The `hardware_platform` field identifies the processor, module, or computing platform on which
the controller firmware runs. Examples include `ESP32-P4`, `Teensy 4.1`, and `RP2040`. It is
informational and does not imply particular capabilities; clients MUST accept and expose unknown
values. When a device cannot determine its platform, it MUST report `unknown`.

The `transport` field identifies the active transport carrying the current Opalinx connection. It
does not identify intermediate adapters: a controller receiving Opalinx through a UART reports
`uart`, even when the host reaches that UART through a USB-to-UART bridge. Standard transport
identifiers are lowercase ASCII:

| Identifier      | Transport                                      |
|-----------------|------------------------------------------------|
| `uart`          | Hardware UART                                  |
| `usb-cdc`       | USB Communications Device Class serial         |
| `tcp`           | Transmission Control Protocol                  |
| `bluetooth-spp` | Bluetooth Serial Port Profile / RFCOMM         |

Future specifications may define additional identifiers. Vendor-defined transports SHOULD use a
namespaced identifier such as `vendor.example/custom-link`. Clients MUST accept and expose unknown
transport identifiers and MUST NOT reject a device because its transport is unrecognized. The
transport string identifies the binding only; it MUST NOT contain link speed, driver, adapter, or
other diagnostic details.

#### INFO extensions

Immediately after the 14-byte fixed prefix, the remainder of the INFO payload contains
type-length-value (TLV) information records. Each record has this structure:

| Field  | Size     | Description                                      |
|--------|----------|--------------------------------------------------|
| Type   | 1 byte   | Extension type identifier                        |
| Length | 2 bytes  | Value length in bytes, unsigned little-endian    |
| Value  | variable | Exactly `length` bytes                           |

Type assignments are divided into these ranges:

| Range           | Purpose                                                     |
|-----------------|-------------------------------------------------------------|
| `0x00`          | Reserved; senders MUST NOT emit                              |
| `0x01`–`0x05`   | Standard Opalinx 1.0 information records                         |
| `0x06`–`0x7F`   | Standard extensions assigned by future Opalinx specifications   |
| `0x80`–`0xFF`   | Vendor-specific extensions                                   |

The outer INFO payload length terminates the extension area; no end marker or padding is permitted.
Every record, including an unknown record, MUST fit completely within that payload. A truncated TLV
header, a value shorter than its declared length, or trailing bytes that cannot form a complete TLV
make the INFO response malformed and MUST cause the host to reject it.

Hosts MUST parse through the entire information-record area and MUST skip unknown record types using their
declared lengths. Unknown standard or vendor extensions MUST NOT make an otherwise compatible device
fail discovery. A sender MUST NOT repeat an extension type unless that extension's definition
explicitly permits repetition. A host MUST reject duplicate instances of a known non-repeatable type;
it MAY preserve or expose unknown records, including repeated unknown types, for diagnostics.

The Opalinx 1.0 standard records are:

| Type   | Name                | Requirement | Value                                             |
|--------|---------------------|-------------|---------------------------------------------------|
| `0x01` | Firmware version    | Required    | Exactly 3 bytes: major, minor, patch              |
| `0x02` | Device name         | Optional    | UTF-8, `0`–`255` bytes; omission means no name    |
| `0x03` | Hardware revision   | Required    | UTF-8, `1`–`63` bytes                             |
| `0x04` | Hardware platform   | Required    | UTF-8, `1`–`63` bytes                             |
| `0x05` | Transport           | Required    | UTF-8 identifier, `1`–`63` bytes                  |

Every required record MUST occur exactly once. A known standard record with an invalid length or a
duplicate known record makes INFO malformed. Record order has no meaning; senders SHOULD emit
standard records in ascending type order for deterministic diagnostics. Adding a standard record is
additive and does not change the offsets or interpretation of the fixed prefix. Changing, removing,
or reordering a fixed field requires an incompatible protocol revision.

**Capability flags** (bit positions within the 32-bit little-endian field):

| Bit  | Name                     | Meaning                                                        |
|------|--------------------------|----------------------------------------------------------------|
| 0    | `CAP_RGBW`               | Device supports 4-component (RGBW) color orders                |
| 1    | `CAP_PER_CHANNEL_CONFIG` | Device supports per-channel configuration                      |
| 2    | `CAP_PER_CHANNEL_SHOW`   | Device supports per‑channel Show                               |
| 3–31 | Reserved                 | MUST be `0` in senders; MUST be ignored by receivers           |

Clients MUST ignore unknown capability bits to remain forward-compatible.

The mandatory one-deep `Show` queue is **not** a capability bit or INFO field. Every conformant
device supports one actively transmitting plus one queued `Show` as part of the base contract (see
[Frame Pipelining](#frame-pipelining)). A future advanced streaming model is a separate additive
feature and does not alter these messages.

### CONFIG (`0x82`, `0xA0`)

Sent in response to [`Request Device Configuration`](#request-device-configuration-0x02)
(`0x82`) or after a successful [`Configure Device`](#configure-device-0x20) message (`0xA0`).
Both identifiers share the same payload structure.

| TRANSACTION ID | IDENTIFIER    | PAYLOAD LENGTH | PAYLOAD   | CHECKSUM |
|----------------|---------------|----------------|-----------|----------|
| 2 bytes        | `0x82`/`0xA0` | 2 bytes        | see below | 2 bytes  |

**Payload structure**:

The payload contains one **channel configuration entry** per channel, in channel-number order
(channel 0 first, channel `N-1` last).

Each entry has the following structure:

| Field            | Size    | Description                                           |
|------------------|---------|-------------------------------------------------------|
| Color order      | 1 byte  | Encoding matches the `Configure Device` message       |
| Protocol         | 1 byte  | Encoding matches the `Configure Device` message       |
| LED count        | 2 bytes | 16-bit unsigned integer, little-endian                |

### PONG (`0x83`)

Sent in response to [`Ping`](#ping-0x03).

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | CHECKSUM |
|----------------|------------|----------------|----------|
| 2 bytes        | `0x83`     | `0x00` `0x00`  | 2 bytes  |

### SET_PIXELS_ACK (`0xC0`)

Sent in response to a successful [`Set Pixels`](#set-pixels-0x40) request with `TxID ≠ 0x0000`,
confirming that the pixel data has been buffered.

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | CHECKSUM |
|----------------|------------|----------------|----------|
| 2 bytes        | `0xC0`     | `0x00` `0x00`  | 2 bytes  |

### FILL_CHANNEL_ACK (`0xC1`)

Sent in response to a successful [`Fill Channel`](#fill-channel-0x41) request with `TxID ≠ 0x0000`,
confirming that the fill has been buffered.

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | CHECKSUM |
|----------------|------------|----------------|----------|
| 2 bytes        | `0xC1`     | `0x00` `0x00`  | 2 bytes  |

### SHOW_ACK (`0xD0`)

Sent in response to a successful [`Show`](#show-0x50) request with `TxID ≠ 0x0000`, after LED
transmission has completed.

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | CHECKSUM |
|----------------|------------|----------------|----------|
| 2 bytes        | `0xD0`     | `0x00` `0x00`  | 2 bytes  |

### RESET_ACK (`0xD1`)

Sent in response to a successful [`Reset`](#reset-0x51), after LED transmission has completed.

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | CHECKSUM |
|----------------|------------|----------------|----------|
| 2 bytes        | `0xD1`     | `0x00` `0x00`  | 2 bytes  |

### ERROR (`0xE0`)

Sent by the device to report a protocol or operational error. Every rejected message MUST trigger
an `ERROR` response.

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | PAYLOAD   | CHECKSUM |
|----------------|------------|----------------|-----------|----------|
| 2 bytes        | `0xE0`     | 2 bytes        | see below | 2 bytes  |

**Payload structure**:

| Field                | Size     | Description                                                    |
|----------------------|----------|----------------------------------------------------------------|
| Error code           | 1 byte   | See error codes below                                          |
| Offending identifier | 1 byte   | Id byte of message that caused error; `0x00` if unknown        |

**Error codes**:

| Value         | Name                         | Meaning                                           |
|---------------|------------------------------|---------------------------------------------------|
| `0x00`        | `ERR_UNSPECIFIED`            | Generic error                                     |
| `0x01`        | `ERR_UNKNOWN_IDENTIFIER`     | Identifier byte not recognized                    |
| `0x02`        | `ERR_INVALID_PAYLOAD_LENGTH` | Payload length ≠ message's expected size          |
| `0x03`        | `ERR_CRC_MISMATCH`           | CRC-16 validation failed                          |
| `0x04`        | `ERR_INVALID_PARAMETER`      | A parameter value is out of range                 |
| `0x05`        | `ERR_BUSY`                   | Device cannot accept the message at this time     |
| `0x06`        | `ERR_UNSUPPORTED`            | Message valid but unsupported by this device      |
| `0x07`        | `ERR_FRAMING_ERROR`          | COBS decoding failed or decoded frame is shorter than 7 bytes |
| `0x08`–`0x7F` | Reserved                     | Reserved for future specification versions        |
| `0x80`–`0xFF` | Vendor-specific              | Available for vendor-specific error codes         |

Devices SHOULD emit the most specific applicable error code. `ERR_UNSPECIFIED` is reserved for
conditions not covered by any other code and SHOULD NOT be used when a more specific code applies.

`ERR_BUSY` governs messages that arrive while the device is still transmitting a previous frame to
the LEDs:

- A valid `Show` received in `ACTIVE` MUST be accepted and queued. A valid `Show` received in
  `ACTIVE_QUEUED` MUST be rejected with `ERR_BUSY`.
- A `Reset` request received in `ACTIVE` or `ACTIVE_QUEUED` MUST be rejected with `ERR_BUSY`.
  `Reset` is a management command, not a streaming operation, and is not queued.
- `Configure Device` MUST be rejected with `ERR_BUSY` in `ACTIVE` or `ACTIVE_QUEUED`.
- `Set Pixels` and `Fill Channel` MUST be accepted in `ACTIVE`, when staging is free, and MUST be
  rejected with `ERR_BUSY` in `ACTIVE_QUEUED`, when staging is reserved for the queued frame.

These rules are summarized normatively in the [pipeline admission table](#device-states).

When `ERR_FRAMING_ERROR` is emitted, the transaction ID in the response MUST be `0x0000` and the
offending identifier MUST be `0x00`, as neither could be recovered from the malformed frame.

**Opalinx** 1.0 uses the transaction ID echoed in every response — including `ERROR` responses — to
correlate device replies with host requests.


## Example Session

A typical client session driving 300 RGB LEDs per channel on an 8-channel device:

1. Client opens serial connection.
2. Client sends `Request Device Information` (`0x01`) to verify device presence and capabilities;
   device responds with `INFO` (`0x81`).
3. Client sends `Configure Device` (`0x20`) with channel `255`, GRB color order, the WS2811 800 kHz
   protocol, and 300 LEDs per channel; device responds with `CONFIG` (`0xA0`).
4. Client sends `Set Pixels` (`0x40`) for channel 0 with 900 bytes (300 × 3) of pixel data.
5. Client sends `Set Pixels` for channels 1 through 7 in the same manner.
6. Client sends `Show` (`0x50`) with channel `255` to commit all eight channels simultaneously to
   the LEDs.
7. Client repeats steps 4–6 for each new frame.

For installations where all channels display the same content (mirror mode), steps 4–5 collapse
into a single `Set Pixels` with channel `255`.


## Transport Bindings

### Core stream contract

**Opalinx** 1.0 is defined over one full-duplex, reliable, ordered byte stream connecting one host to
one device. A conforming core binding MUST:

- deliver accepted bytes once, in order, without insertion or duplication;
- preserve the complete COBS-encoded frame stream, including `0x00` delimiters;
- provide backpressure, flow control, buffering, or an equivalent mechanism sufficient to prevent
  routine receive overruns at the binding's documented operating rate;
- expose connection loss as a transport failure rather than silently reconnecting a new peer into an
  existing Opalinx session;
- reset partial-frame accumulation at a connection boundary.

CRC and delimiter recovery detect corruption and restore framing after a fault; they do not make an
unreliable transport reliable. Loss of a valid fire-and-forget request cannot be recovered by the
core protocol, and transaction IDs provide correlation rather than retransmission or deduplication.

The following standard identifiers denote direct core-stream bindings:

- **`usb-cdc`**: Opalinx frames are carried unchanged over a USB CDC byte stream.
- **`uart`**: Opalinx frames are carried unchanged over a hardware UART. The implementation MUST choose
  baud rate, buffering, and hardware/software flow control so the documented operating mode meets the
  core stream contract. A UART overrun is a transport failure even if the parser later resynchronizes.
- **`tcp`**: One Opalinx session occupies one established TCP connection. Frames are carried unchanged
  over the connection's byte stream.
- **`bluetooth-spp`**: Frames are carried unchanged over one Bluetooth RFCOMM/SPP stream.

### Packet and non-stream transports

UDP and Bluetooth LE GATT are not standard Opalinx 1.0 core bindings. Merely placing one encoded frame
in a datagram, characteristic write, or notification does not supply the ordering and reliability
contract the protocol requires.

A future standard packet binding—or a vendor-defined experimental binding—must define at least:

- mapping between Opalinx frames and packets;
- maximum transmission unit and fragmentation/reassembly;
- packet and fragment ordering;
- loss detection, acknowledgement, and retransmission;
- duplicate detection and suppression, especially for non-idempotent requests;
- session establishment, peer identity, and reconnection behavior;
- backpressure and maximum outstanding data;
- delivery and timeout behavior for responses and unsolicited errors.

Until such a binding is published, an implementation using UDP, BLE GATT, or another non-stream
transport MUST use a vendor-namespaced `transport` identifier such as
`vendor.example/udp-binding-v1`; it MUST NOT report the unqualified identifiers `udp` or
`bluetooth-le` or claim conformance to a standard Opalinx binding. Its binding document is responsible
for presenting reliable ordered frame delivery to the Opalinx layer.

**Timeouts**: Hosts MUST implement a timeout when waiting for a response to messages that always
produce one (`Request Device Information`, `Request Device Configuration`, `Configure Device`,
and `Ping`). A suggested timeout is 1 second over USB serial; timeouts may be adjusted for a
higher-latency conforming binding. When waiting for `SHOW_ACK` or
`RESET_ACK`, hosts MUST use the component count, configured signaling protocol, LED count, and reset
interval to calculate the physical frame duration as defined in [Frame Pipelining](#frame-pipelining),
rather than relying on a fixed timeout. A `Show` accepted while another frame is active may wait for
the remainder of that active frame and then transmit its own frame before its `SHOW_ACK` is emitted;
a conservative timeout therefore allows up to two affected-frame durations when both frames have the
same configuration. With heterogeneous configurations, use the maximum possible remaining duration
of the active frame plus the duration of the acknowledged frame. A `RESET_ACK` needs one zero-frame
duration because `Reset` is rejected while output is already active; that frame uses the device's
power-on default configuration. A host that cached the initial `CONFIG` response can calculate this
duration directly. Otherwise it SHOULD use the advertised LED limits to derive a conservative bound,
or fall back to a documented implementation-specific management timeout when those limits are `0`
(not advertised). Hosts MUST add transport, scheduling, and implementation margin to these physical
minima.

Future versions may define additional stream or packet bindings without changing the core frame
format, provided each binding supplies the delivery contract above.


## Conformance

An implementation is considered **Opalinx** 1.0 conformant if it:

- Accepts all request messages defined in this specification with the framing described.
- Implements the bounded accumulation, oversized-frame discard, delimiter recovery, and exact
  validation order defined in [Receiver Framing and Recovery](#receiver-framing-and-recovery).
- Rejects malformed messages by emitting an appropriate `ERROR` response without affecting the
  state of prior valid messages.
- Responds to `Request Device Information` with a properly formatted `INFO` response containing
  all required fields.
- Responds to `Request Device Configuration` with a properly formatted `CONFIG` response.
- Responds to `Configure Device` with a `CONFIG` response on success or an appropriate `ERROR`
  response on failure; on success, clears the pixel buffer of every affected channel to all-zeros
  atomically (for broadcast, either all channels are updated or none).
- Responds to `Ping` with a `PONG` response.
- Responds to `Reset` with a `RESET_ACK` response after LED transmission completes, and rejects a
  `Reset` received during active transmission with `ERR_BUSY`.
- Implements the pipeline states, admission table, atomic promotion order, and acknowledgement
  guarantees defined in [Frame Pipelining](#frame-pipelining).
- Sends `SET_PIXELS_ACK`, `FILL_CHANNEL_ACK`, and `SHOW_ACK` responses for pixel and show
  operations received with `TxID ≠ 0x0000`.
- Ignores unknown capability flags and reserved fields per the [Conventions](#conventions)
  section.
- Honors the `0x70`–`0x7F` and `0xF0`–`0xFF` vendor-specific identifier ranges by either
  implementing them or rejecting them cleanly with `ERR_UNKNOWN_IDENTIFIER`.

Implementations MAY add vendor-specific requests in the `0x70`–`0x7F` range and vendor-specific
responses in the `0xF0`–`0xFF` range. Clients encountering vendor-specific messages they do not
recognize SHOULD ignore them.


## Security Considerations

**Opalinx** 1.0 provides no authentication, authorization, or encryption. It assumes the underlying
transport is trusted.

For USB serial connections this assumption is reasonable: physical access to the host is required
to open the port, which implies the ability to control any connected device.

For network transports (TCP, Bluetooth RFCOMM/SPP), the assumption does not hold automatically.
Any endpoint that can reach the device's network address or Bluetooth service can send arbitrary
**Opalinx** commands — configuring channels, overwriting pixel buffers, and issuing resets — without
any credential. Deployments using these transports MUST secure the transport layer externally
(e.g., TLS for TCP, authenticated pairing for Bluetooth) or restrict access at the network or
OS level before exposing an **Opalinx** device.

The CRC-16 checksum detects accidental bit errors in transit; it does not provide tamper
protection. An attacker with the ability to modify frames in transit can recompute a valid CRC
over altered data. **Opalinx** offers no mechanism to detect or prevent deliberate tampering.


## Specification Governance

**Opalinx** is a centrally governed protocol. The author and maintainer of this repository is the sole
authority for publishing official versions of the **Opalinx** specification.

Proposed changes, clarifications, and extensions may be submitted for discussion, but only versions
published by the official **Opalinx** repository are considered authoritative.


## License Summary

Opalinx is free to implement in software. You may create, distribute, sell, or commercially license
software libraries, host applications, plugins, tools, test suites, tutorials, and integrations that
communicate with Opalinx-compatible devices.

You may also implement Opalinx in hardware or firmware for personal, educational, artistic, research,
prototyping, and other non-commercial uses.

A separate commercial license is required to manufacture, sell, distribute, bundle, lease, rent,
market, or otherwise commercialize hardware devices, firmware products, kits, modules, or
installation systems that implement Opalinx or advertise Opalinx compatibility.

In short:

- commercial Opalinx software is allowed;
- non-commercial Opalinx hardware experimentation is allowed;
- commercial Opalinx-compatible devices require a license;
- the official Opalinx specification remains under the authority of Jean-Philippe
  Côté.

See [`LICENSE.md`](LICENSE.md) for the full legal text.


## Name Usage

The name "**Opalinx**" refers exclusively to the protocol defined by the canonical specification.

Modified, extended, or incompatible protocols must not be described as **Opalinx** or
**Opalinx**-compatible.

The name "**Opalinx**" may only be used to refer to implementations or documents that conform to the
official **Opalinx** specification published by the author.


## Contributing

Feedback, questions, and proposed extensions are welcome. Please open an issue on this repository
to discuss changes before submitting pull requests against the specification text.


## Author

Opalinx was designed and authored by [Jean-Philippe Cô](https://djip.co), 2026.
