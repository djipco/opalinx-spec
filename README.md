# Opalinx Protocol Specification
### Version: 1.0.0-alpha.0

> [!WARNING]
> **This is a prerelease specification and is not production-ready.** Breaking changes may occur
> before `1.0.0`.

**Opalinx** is a lightweight binary protocol that allows interfacing with compatible LED controllers
over a reliable byte stream (typically, serial over USB).


## Scope

**Opalinx** targets one-wire, addressable-LED chips in the **WS281x** family, including **WS2811**,
**WS2812**, **WS2812B**, **WS2813**, and their variants (e.g., **WS2814**, **WS2815**, **SK6812**).
Both 3-component (RGB) and 4-component (RGBW) chips are supported.


## Conventions

- **Key words**: **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used as
  defined in [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

- **Byte order**: All multi-byte integer fields are little-endian.

- **Strings**: UTF-8 encoded with a length prefix, not null-terminated.

## Versioning and wire compatibility

Specification releases follow [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). The 
three protocol-version bytes at the start of `INFO` carry only the SemVer core `major.minor.patch`; 
they do not encode prerelease or build metadata. These bytes identify the wire contract, not the 
firmware or library release.

A host MUST inspect the three-byte version preamble before parsing the version-specific remainder of
`INFO`. An `INFO` payload shorter than three bytes is malformed. If the major version is unsupported,
the host MUST stop parsing, reject the device, and send no state-changing requests. Within a supported
major version, feature support is determined by the messages, capability bits, and information records
defined for those features—not by comparing minor or patch numbers alone.


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

Each endpoint MUST bound the amount of data retained for an encoded frame. A device MUST accept a
frame carrying any request payload up to its advertised `max_payload_length`. A host MUST accept a
frame carrying any response payload up to the protocol maximum of 65535 bytes. In both cases the
supported encoded-frame length includes the seven decoded framing bytes and worst-case COBS
overhead. If a nonzero-delimited run exceeds the applicable limit, the receiver MUST discard the
entire run through its terminating `0x00`. It MUST NOT decode or dispatch any prefix of that run.
This rule does not prescribe a parser state machine or storage strategy.

On receipt of a delimiter, the receiver MUST behave as follows:

1. A run previously identified as oversized is silently discarded. No field in its incomplete
   prefix is trustworthy, so it cannot be correlated.
2. A delimiter with no preceding bytes is a lone delimiter and MUST be silently ignored.
3. Otherwise, the bytes since the previous delimiter form one candidate frame. Processing that
   candidate MUST NOT prevent reception or independent processing of the next candidate.

A COBS-decoded frame has a minimum size of seven bytes: transaction ID (2), identifier (1), payload
length (2), and CRC (2). A device MUST silently discard a candidate if COBS decoding fails or
produces fewer than seven bytes.

For a decoded frame of at least seven bytes, the following list defines rejection precedence. If a
candidate violates more than one rule, the externally visible result MUST correspond to the first
applicable rule. An implementation need not perform checks in this order, but it MUST NOT dispatch a
request unless every applicable structural check has passed.

1. **CRC**: The received checksum is always the final two decoded bytes. It MUST NOT be located using
   the untrusted payload-length field. Calculate the CRC over every preceding decoded byte. On
   mismatch, silently discard the candidate. The recovered transaction ID and identifier are not
   trustworthy when the checksum fails.
2. **Identifier and direction**: A device accepts request identifiers `0x01`–`0x7F`. It MUST reject
   `0x00` and response-space identifiers `0x80`–`0xFF` with `ERR_UNKNOWN_IDENTIFIER`, echoing the
   recovered transaction ID and offending identifier.
3. **Declared payload length**: The decoded size MUST equal `7 + payload_length`. A mismatch MUST
   produce `ERR_INVALID_PAYLOAD_LENGTH`, echoing the recovered transaction ID and identifier.
4. **Advertised request limit**: A structurally valid request payload exceeding the device's
   advertised `max_payload_length` MUST produce `ERR_INVALID_PAYLOAD_LENGTH` when the complete
   candidate was retained. A candidate discarded before its delimiter under the oversized-frame
   rule receives no response.
5. **Message-specific payload length**: A payload whose size differs from the exact size required by
   its recognized message identifier MUST produce `ERR_INVALID_PAYLOAD_LENGTH`.
6. **Parameter values and operational state**: Only after all preceding checks pass may the receiver
   validate field values or dispatch the request.

The oversized-frame rule is the only exception to CRC-first validation: the complete frame and its
checksum were never retained, so CRC validation is impossible. An oversized frame causes exactly one
silent discard at its terminating delimiter and MUST NOT affect previously accepted protocol or pixel
state.

A host receiving device output MUST apply the same bounded framing and delimiter recovery rules, but
its internal validation order is not externally observable and need not match the device order above.
Before accepting or correlating a response, it MUST validate COBS structure, minimum size, CRC,
declared length, identifier/direction, and message-specific structure. It MUST treat the checksum as
the final two decoded bytes rather than locating it through the untrusted payload-length field, and
MUST NOT allocate unbounded storage from an unverified length. A failure is reported locally; the host
discards the candidate, continues at the next delimiter, and MUST NOT send an `ERROR` response.

**Fields**:

 - **Transaction ID**: A 16-bit unsigned integer, little-endian, generated by the host for each
   request. The device MUST echo the same value in the corresponding response. `0x0000` is a
   reserved sentinel meaning "no correlation required"; hosts MAY use it for fire-and-forget
   requests. A device MUST NOT send any success or `ERROR` response to a request carrying
   `TxID = 0x0000`. A host MUST NOT reuse a nonzero transaction ID while a response to its earlier
   request could still arrive in the same session. Receipt of the response retires that transaction
   ID; a local timeout alone does not. If correlation can no longer be maintained after a timeout,
   the host MUST end the session before reusing the transaction ID. Hosts that increment `TxID`
   sequentially MUST skip `0x0000` when wrapping, advancing from `0xFFFF` to an available nonzero
   value. Hosts using `TxID = 0x0000` accept that rejection and loss are silent; traffic requiring
   confirmation or error reporting MUST use a nonzero transaction ID.

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
integer). Every implementation MUST accept at least 9 payload bytes, enough for one RGBW
`Set Pixels` operation (`5` addressing bytes + `4` component bytes). Implementations intended
for high-throughput streaming SHOULD accept at least 4101 payload bytes, sufficient for 1365 RGB or
1024 RGBW LEDs per `Set Pixels` message, but this is a performance recommendation rather than a
conformance requirement.

Each device advertises the largest request payload it accepts in the `max_payload_length` field of
the `INFO` response. This is a wire limit, not a statement about storage or processing architecture.
Clients MUST derive their chunk size from that field and MUST NOT send a request payload exceeding
the advertised value. Because `Set Pixels` carries an LED offset, an arbitrarily long channel can be
updated through multiple messages without requiring the whole channel to fit in one payload. The
rejection and recovery rules for requests exceeding this limit are defined in
[Receiver Framing and Recovery](#receiver-framing-and-recovery). After COBS encoding, a frame grows
by at most one byte per 254 bytes of input plus the `0x00` delimiter. The supported encoded-frame
limit therefore includes the seven framing bytes, the payload, worst-case COBS overhead, and the
delimiter.

**CRC**:

The format used is **CRC-16/CCITT-FALSE** with the following parameters:

 - Polynomial: `0x1021`
 - Initial value: `0xFFFF`
 - No input reflection, no output reflection, no final XOR.

> [!NOTE]
> Implementations can verify their CRC by computing it over the ASCII string `"123456789"`, which
> MUST yield `0x29B1`.

Receivers MUST validate the CRC on every complete COBS-decoded candidate of at least seven bytes and
MUST silently discard a candidate with an invalid CRC. Candidates that cannot be
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
| `0x70` – `0x7E` | Reserved                                                   |
| `0x7F`          | Standard namespaced vendor request envelope                 |

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
| `0xF0` – `0xFE` | Reserved                                                   |
| `0xFF`          | Standard namespaced vendor response envelope                |

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

`N` MUST be in the range `1`–`255`, so Opalinx 1.0 addresses at most 255 numbered channels
(`0`–`254`) on one device. The value `255` always means broadcast and MUST NOT be reinterpreted as a
numbered channel by an extension.

### Addressing limits

Opalinx 1.0 deliberately uses compact fixed-width addressing:

| Resource | 1.0 limit | Consequence |
|----------|-----------|-------------|
| Numbered channels per device | 255 | Channel indices `0`–`254`; `255` remains broadcast |
| LEDs per channel | 65,535 | Valid configured indices are `0`–`65,534` |
| Pixel offset and count | 16 bits each | One `Set Pixels` span cannot end beyond exclusive index `65,535` |

The mathematical sum `LED_offset + LED_count` MUST NOT exceed 65,535. A wrapped 16-bit result does
not make an otherwise invalid span valid.

## Request Messages

### Request Device Information (`0x01`)

Queries the device for its identity and protocol compatibility. Clients MUST obtain and validate
INFO before sending state-changing or vendor requests in a new session. INFO and CONFIG queries may
otherwise be sent in either order.

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

### Configure Device (`0x20`)

Sets the LED color order, signaling protocol, and LED count for one channel, or for all channels
simultaneously (broadcast). Clients SHOULD send this during initialization, before streaming any
pixel data.

| TX ID   | IDENTIFIER | PAYLOAD LENGTH | CHANNEL | COLOR ORDER | PROTOCOL | LED COUNT | CHECKSUM |
|---------|------------|----------------|---------|-------------|----------|-----------|----------|
| 2 bytes | `0x20`     | `0x05` `0x00`  | 1 byte  | 1 byte      | 1 byte   | 2 bytes   | 2 bytes  |

**Channel number**:

- `0` through `N-1`: reserved for future per-channel configuration; devices MUST reject with
  `ERR_UNSUPPORTED`.
- `255`: broadcast. Applies the same configuration to all channels simultaneously.

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

Values `0x00`–`0x05` are 3-component (RGB) and `0x06`–`0x1D` are 4-component (RGBW). Other values
are unassigned in 1.0 and MUST be rejected with `ERR_INVALID_PARAMETER`. Every device MUST support
both 3-component and 4-component color orders. CONFIG readers
MUST preserve and expose an unknown numeric color-order value rather than rejecting the entire
response; a host MUST NOT send a color-order value it does not understand. A future pixel format
with other than three or four components requires new pixel/configuration messages and MUST NOT
reinterpret this field.

**Protocol values**: select the WS281x signaling protocol — the chip family and its bit timing.
(Named `protocol` rather than `speed` because the choice is a signaling variant, not merely a data
rate.)

| Value  | Protocol           |
|--------|--------------------|
| `0x00` | WS2811 at 800 kHz  |
| `0x01` | WS2811 at 400 kHz  |
| `0x02` | WS2813 at 800 kHz  |

Every conformant device MUST support `0x00`. Support for other assigned values is advertised by the
`Supported signaling protocols` INFO record. A host MUST NOT request a protocol value it does not
understand, and SHOULD NOT request a value absent from that record. If the record is absent, only
`0x00` is guaranteed; a host MAY probe another value and handle rejection.

Future same-major specifications MAY assign new values additively. CONFIG readers MUST preserve and
expose unknown numeric protocol values rather than rejecting the response. A device rejects an
unassigned value with `ERR_INVALID_PARAMETER` and an assigned but unsupported value with
`ERR_UNSUPPORTED`.

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
4 bytes for RGBW-family orders. Each LED's bytes represent component values in the channel's
configured wire order (the color order set by `Configure Device`). The resulting LED output MUST
match those wire-order values. A host using a different logical color layout converts it before
forming the request.

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

Any rejected `Set Pixels` message MUST be rejected atomically; no channel's buffer may be modified.
A rejected request with a nonzero transaction ID produces one `ERROR` response.

**Response**: Emits [`SET_PIXELS_ACK`](#set_pixels_ack-0xc0) on success if `TxID ≠ 0x0000`; no
response if `TxID = 0x0000`. Emits [`ERROR`](#error-0xe0) on failure only if `TxID ≠ 0x0000`. For
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
[`Set Pixels`](#set-pixels-0x40) — and the resulting output applies those component values to every
LED. A host using a different logical color layout converts it before forming the request. For
example, on a `GRB` channel the three bytes represent G, R, B in that order.

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
no response if `TxID = 0x0000`. Emits [`ERROR`](#error-0xe0) on failure only if `TxID ≠ 0x0000`. For
high-throughput streaming, `TxID = 0x0000` is recommended to avoid ACK overhead.

### Show (`0x50`)

Commits buffered channel data (from `Set Pixels` and `Fill Channel`) to the physical LEDs. Can
target a single channel or commit all channels atomically.

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | PAYLOAD                  | CHECKSUM |
|----------------|------------|----------------|--------------------------|----------|
| 2 bytes        | `0x50`     | `0x01` `0x00`  | Channel number (1 byte)  | 2 bytes  |

**Channel number**:

- `0` through `N-1`: reserved for future per-channel transmission; devices MUST reject with
  `ERR_UNSUPPORTED`.
- `255`: broadcast. Commits all channels simultaneously, guaranteeing synchronized multi-channel
  updates without inter-channel tearing. Devices MUST start all channel transmissions at the same
  time; this is a hardware conformance requirement.

**Buffer persistence**: Each channel's buffer is initialized to all-zeros at power-on and persists
across `Show` messages, being overwritten only by subsequent `Set Pixels` or `Fill Channel`
messages targeting that channel, or cleared by a successful `Configure Device`. This allows
channels to be updated at independent frame rates.

**Response**: Emits [`SHOW_ACK`](#show_ack-0xd0) after LED transmission completes if
`TxID ≠ 0x0000`; no response if `TxID = 0x0000`. Emits [`ERROR`](#error-0xe0) on failure only if
`TxID ≠ 0x0000`. Hosts that use a non-zero `TxID` for `Show` and wait for `SHOW_ACK` before
issuing the next `Show` are guaranteed never to receive `ERR_BUSY`. For high-throughput streaming,
hosts MUST use acknowledged `Show` requests as described in [Frame Pipelining](#frame-pipelining).
`TxID = 0x0000` is suitable only when the host deliberately does not pipeline and does not require
completion or buffer-safety feedback.

### Frame Pipelining

For Show completion and acknowledgement, physical transmission includes both LED data and the
required reset/latch interval. Opalinx 1.0 uses a minimum reset/latch interval of `300 µs` for its
assigned signaling protocols.

> [!NOTE]
> The following timing calculation is informative. It explains the motivation for pipelining but is
> not a required implementation technique or a host timeout algorithm.

> ```text
> bits_per_led = components_per_led × 8
> data_time    = LED_count × bits_per_led × bit_period
> frame_time   = data_time + reset_time
> ```

> The assigned Opalinx protocol values use a `1.25 µs` bit period at 800 kHz and a `2.5 µs` bit
> period at 400 kHz. Excluding the reset interval, one RGB LED therefore takes approximately `30 µs`
> at 800 kHz or `60 µs` at 400 kHz; one RGBW LED takes approximately `40 µs` at 800 kHz or `80 µs`
> at 400 kHz. A broadcast completes when its slowest affected channel completes.

A host that waits for `SHOW_ACK` before issuing the next `Show` (the lock-step pattern above) leaves
the device idle for one host round-trip at every frame boundary, because the device cannot begin the
next frame until a new `Show` arrives. Frame pipelining removes that idle gap by letting the host
queue the next `Show` while the current frame is still transmitting.

**Opalinx 1.0 supports exactly one pending `Show`.** A device may have one `Show` transmitting and
one additional `Show` waiting behind it. This fixed backlog is mandatory and requires no capability
negotiation. A third `Show` is rejected with `ERR_BUSY`.

Accepting a `Show` logically captures the staged frame for that operation. Once captured, later
requests cannot alter it. This is an observable frame-isolation guarantee, not a storage or
processing requirement.

The pipeline is global to the device, including when per-channel `Show` is supported:

| State | Meaning |
|-------|---------|
| `IDLE` | No Show is transmitting or pending |
| `ACTIVE` | One Show is transmitting; no Show is pending |
| `ACTIVE_PENDING` | One Show is transmitting and one Show is pending |

Pixel transmission includes the required reset/latch interval. The active Show does not complete
until that interval ends.

After validating a request, the device applies this admission table. Rejection does not change
pipeline or pixel state.

| Request | `IDLE` | `ACTIVE` | `ACTIVE_PENDING` |
|---------|--------|----------|------------------|
| `Set Pixels`, `Fill Channel` | Accept | Accept for the next frame | `ERR_BUSY` |
| `Show` | Start and enter `ACTIVE` | Capture as pending and enter `ACTIVE_PENDING` | `ERR_BUSY` |
| `Configure Device`, `Reset` | Accept | `ERR_BUSY` | `ERR_BUSY` |
| Query requests | Accept | Accept | Accept |

The table applies after message-specific length, parameter, capability, and device-operational
checks. For example, an invalid channel produces `ERR_INVALID_PARAMETER`, not `ERR_BUSY`. Vendor
requests define their own admission rules.

When the active Show completes:

- with no pending Show, the device enters `IDLE`;
- with a pending Show, the device starts it and enters `ACTIVE`.

Only after that transition does the device emit `SHOW_ACK` for the completed Show, if its transaction
ID is nonzero. A `SHOW_ACK` therefore proves that the named Show has completed and that the host may
prepare another frame. Show acknowledgements are emitted in accepted order.

A pipelining host uses a distinct nonzero transaction ID for each outstanding Show and keeps no more
than two Shows outstanding. Pixel updates may use transaction ID zero. The normal sequence is:

1. Prepare and submit frame *N* with `Show(N)`.
2. While *N* transmits, prepare and submit frame *N+1* with `Show(N+1)`.
3. Wait for `SHOW_ACK(N)` before preparing frame *N+2*.

Waiting for the final Show's acknowledgement drains the pipeline.

A future specification may add a larger backlog or a different streaming model, but it MUST
advertise that model explicitly and use separate messages. It MUST NOT change the behavior of the
Opalinx 1.0 `Set Pixels`, `Fill Channel`, or `Show` messages.

### Reset (`0x51`)

Resets the device to its power-on state: clears all channel buffers to zero, restores all channel
configurations to their defaults, and outputs zeros to the physical LEDs. Clients MAY send this
to establish a known state after connection or after an error condition.

| TRANSACTION ID | IDENTIFIER | PAYLOAD LENGTH | CHECKSUM |
|----------------|------------|----------------|----------|
| 2 bytes        | `0x51`     | `0x00` `0x00`  | 2 bytes  |

**Response**: With a nonzero transaction ID, [`RESET_ACK`](#reset_ack-0xd1) after LED transmission
completes, or [`ERROR`](#error-0xe0) on failure. A Reset carrying transaction ID zero produces no
response. Because Reset is a management command, hosts SHOULD always use a nonzero transaction ID.

### Namespaced Vendor Request (`0x7F`)

Carries an extension command without consuming a globally shared identifier. Its payload is:

| Field            | Size      | Description                                       |
|------------------|-----------|---------------------------------------------------|
| Namespace length | 1 byte    | Namespace length `1`–`63`                         |
| Namespace        | variable  | Lowercase ASCII reverse-DNS name                  |
| Command ID       | 2 bytes   | Vendor-assigned identifier, little-endian         |
| Vendor payload   | remaining | Defined by the namespace and command; may be empty |

A namespace contains only lowercase ASCII letters, digits, hyphens, and periods; its first and last
characters MUST be a letter or digit. The owner of a DNS name controls its reverse-DNS namespace,
such as `com.example.lighting`. Command IDs are assigned independently within each namespace.

A device that does not implement the namespace or command MUST return `ERR_UNSUPPORTED`. Invalid
envelope structure produces `ERR_INVALID_PAYLOAD_LENGTH`; an invalid namespace produces
`ERR_INVALID_PARAMETER`. With a nonzero transaction ID, success MUST produce a
[`Namespaced Vendor Response`](#namespaced-vendor-response-0xff). With transaction ID zero, neither
success nor failure produces a response. A vendor contract requiring confirmation MUST forbid
fire-and-forget use and require a nonzero transaction ID.

All vendor-defined requests use this envelope. The reserved request and response ranges MUST NOT be
used as private extension points.

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
| Channel count           | 1 byte   | Number of 1.0-addressable channels (`N`), `1`–`255`          |
| Capability flags        | 1 byte   | Reserved capability bitfield; see below                     |
| Max payload length      | 2 bytes  | Largest accepted request payload, little-endian; MUST be ≥ 9 |
| Information records     | variable | TLV records containing identity and extension information   |

The fixed prefix is exactly 7 bytes. Firmware identity and descriptive strings are information records
so future metadata does not enlarge or reorder the compatibility prefix.

INFO does not advertise configuration limits. A device validates every `Configure Device` request
and reports `ERR_INVALID_PARAMETER` when a requested configuration is unsupported.

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

Immediately after the 7-byte fixed prefix, the remainder of the INFO payload contains
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
| `0x01`–`0x06`   | Standard Opalinx 1.0 information records                      |
| `0x07`–`0xFE`   | Reserved for future standard Opalinx information records      |
| `0xFF`          | Standard namespaced vendor-information envelope               |

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
| `0x06` | Supported signaling protocols | Conditional | Complete ascending set of accepted one-byte protocol values |
| `0xFF` | Vendor information  | Optional    | Namespaced vendor-information envelope            |

Every required record MUST occur exactly once. A known standard record with an invalid length or a
duplicate known record makes INFO malformed. Record order has no meaning; senders SHOULD emit
standard records in ascending type order for deterministic diagnostics. Adding a standard record is
additive and does not change the offsets or interpretation of the fixed prefix. Changing, removing,
or reordering a fixed field requires an incompatible protocol revision.

Every device supports the baseline signaling protocol `0x00`. Absence of record `0x06` means that
`0x00` is the device's complete supported set. A device that accepts any other signaling-protocol
value in `Configure Device` MUST include record `0x06`; when present, the record MUST list the
complete supported set, including `0x00`, in ascending numeric order. Values are one byte each, the
record MUST be non-empty, and no value may repeat. Unknown values are retained as numbers; their
presence does not make INFO incompatible.

Capability flags are reserved for future simple boolean facts. A feature with parameters, variants,
limits, or negotiation rules uses a dedicated information record rather than one capability per
variant. For example, supported signaling protocols are advertised by record `0x06`.

The `0xFF` vendor-information value contains namespace length (1 byte), namespace, vendor record ID
(2 bytes little-endian), and vendor data. Namespace syntax and ownership match the Namespaced Vendor
Request. Type `0xFF` MAY repeat because each `(namespace, vendor record ID)` pair is independently
identified; a sender MUST NOT repeat the same pair. Types `0x07`–`0xFE` MUST NOT be used as private
extension points.

**Capability flags**: all eight bits are unassigned in Opalinx 1.0. Devices MUST send zero. Hosts
MUST ignore bits they do not understand. A future specification may assign bits for simple boolean
features or define an information record when additional or structured capability data is needed.

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

INFO and CONFIG have separate roles: INFO describes device identity, topology, capabilities, and
limits; CONFIG describes mutable per-channel output settings. CONFIG intentionally does not repeat a
channel-count field because its entry count is unambiguously derived from its payload length.

A CONFIG payload is structurally valid when its length is a nonzero multiple of four; it contains
`payload_length / 4` entries and can be parsed without INFO. When valid INFO from the same session is
available, the CONFIG entry count MUST equal INFO `channel_count`; otherwise the host MUST reject the
CONFIG as inconsistent and MUST NOT replace cached configuration. INFO cached across a connection
boundary MUST NOT be used for this check.

Each entry has the following structure:

| Field            | Size    | Description                                           |
|------------------|---------|-------------------------------------------------------|
| Color order      | 1 byte  | Encoding matches the `Configure Device` message       |
| Protocol         | 1 byte  | Encoding matches the `Configure Device` message       |
| LED count        | 2 bytes | 16-bit unsigned integer, little-endian                |

Each CONFIG LED count is in the range `1`–`65535`. The number of entries is exactly the INFO
`channel_count`; therefore a conformant 1.0 CONFIG payload contains `1`–`255` entries and is at most
1020 bytes.

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

### Namespaced Vendor Response (`0xFF`)

Sent after successful handling of a [`Namespaced Vendor Request`](#namespaced-vendor-request-0x7f)
with a nonzero transaction ID. Its payload repeats the request's namespace length, namespace, and
command ID, followed by the command-specific response payload. The echoed transaction ID remains the
primary correlation key; repeating the namespace and command prevents decoding under the wrong
vendor contract.

### ERROR (`0xE0`)

Sent by the device to report a protocol or operational error. Every retained request that passes
COBS decoding, minimum-size validation, and CRC validation, but is then rejected, MUST trigger
exactly one `ERROR` response when its transaction ID is nonzero. A device MUST NOT respond to a
request with transaction ID zero, and MUST silently discard oversized runs and uncorrelatable
framing or checksum failures. Thus a received candidate produces at most one response and device
output can never cause an error-response loop.

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
| `0x03`        | Reserved                     | Reserved for future specification versions        |
| `0x04`        | `ERR_INVALID_PARAMETER`      | A parameter value is out of range                 |
| `0x05`        | `ERR_BUSY`                   | Device cannot accept the message at this time     |
| `0x06`        | `ERR_UNSUPPORTED`            | Message valid but unsupported by this device      |
| `0x07`        | Reserved                     | Reserved for future specification versions        |
| `0x08`        | `ERR_DEVICE_FAULT`           | Device failed to complete an otherwise-valid operation |
| `0x09`–`0x7F` | Reserved                     | Reserved for future specification versions        |
| `0x80`–`0xFF` | Reserved                     | Reserved for future specification versions        |

Devices SHOULD emit the most specific applicable error code. `ERR_UNSPECIFIED` is reserved for
conditions not covered by any other code and SHOULD NOT be used when a more specific code applies.
Hosts MUST accept and expose an unknown error code numerically; an unknown code does not make the
otherwise well-formed `ERROR` response malformed.

Vendor commands use standard `ERROR` codes for envelope, parameter, support, busy, and device-fault
conditions defined by the core protocol. Any additional command-specific status or error detail is
carried in the namespaced vendor response payload; vendors MUST NOT allocate private `ERROR` codes.

`ERR_BUSY` governs requests that exceed the one-Show backlog or require mutable pixel/configuration
state that is not currently available. The normative cases are defined by the
[pipeline admission table](#frame-pipelining).

Framing and checksum failures do not produce error responses because they provide no trustworthy
nonzero correlation key. Implementations MAY count or expose these failures through local diagnostics.

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
- expose connection loss as a transport failure rather than silently reconnecting a new peer into an
  existing Opalinx session;
- ensure that bytes received before a connection boundary cannot form a frame with bytes received
  after it.

CRC and delimiter recovery detect corruption and restore framing after a fault; they do not make an
unreliable transport reliable. Loss of a valid fire-and-forget request cannot be recovered by the
core protocol, and transaction IDs provide correlation rather than retransmission or deduplication.

### Connection and session boundaries

One established transport connection is one Opalinx session. Transaction IDs and responses are
scoped to that session and have no meaning after its connection ends. An incomplete frame at a
connection boundary is discarded. A device MUST NOT deliver a response from an ended session to a
later session.

A connection boundary is not a device reset. Device configuration, staging pixel buffers, currently
displayed LED values, and diagnostic counters persist. If physical LED transmission has already
started, it MUST be allowed to finish, but its old-session acknowledgement is discarded. A pending
`Show` that has not started MUST be canceled and its acknowledgement discarded. This pending-Show
cancellation is the sole exception; no other accepted operation is rolled back.

Consequently, a newly connected host MUST NOT assume power-on defaults or known staging contents. It
MAY send INFO and CONFIG-query requests in either order, but MUST obtain compatible INFO before
sending configuration, pixel, Show, Reset, or vendor requests. It SHOULD request the current
configuration and MUST overwrite or reset pixel state before issuing a `Show` unless intentionally
preserving the previous session's content. A `Reset` remains the explicit operation for restoring
power-on state.

Bindings define observable boundaries as follows:

- `usb-cdc`: a session begins when the CDC data interface is opened (DTR asserted) and ends when DTR
  is deasserted, the USB device disconnects, or the interface is reset;
- `tcp`: a session is one established TCP connection;
- `bluetooth-spp`: a session is one established RFCOMM channel;
- `uart`: UART has no intrinsic open/close event. One session begins when the device initializes the
  link and continues until device/link reset, unless the binding documents an out-of-band boundary
  signal. Merely reopening a host serial handle does not create a device-observable new session. A
  UART overrun is a transport failure even if frame parsing later resynchronizes.


## Conformance

For conformance, **recognize** means parsing the standard identifier, applying the specified
validation order, and returning a specific result or error rather than `ERR_UNKNOWN_IDENTIFIER`.
**Support** means successfully executing every otherwise-valid instance within the limits the device
advertises. Recognizing a capability-gated operation and returning `ERR_UNSUPPORTED` when that
capability is not advertised is conformant; advertising a capability and then rejecting an
otherwise-valid use of it is not.

Every conformant device MUST recognize all standard 1.0 request identifiers. The required successful
baseline is:

| Request or mode | Conformance requirement |
|-----------------|-------------------------|
| Device information and configuration query | Mandatory |
| Broadcast Configure using any assigned 3-component order and protocol `0x00` | Mandatory |
| Set Pixels and Fill Channel for valid configured channels | Mandatory |
| Broadcast Show | Mandatory |
| Reset | Mandatory |
| Namespaced vendor request | Envelope validation mandatory; individual namespaces optional |
| RGB and RGBW configuration and data | Mandatory |
| Additional signaling protocols | Mandatory only for values advertised in INFO record `0x06` |

An optional capability or advertised protocol value is a behavioral promise, not merely descriptive
metadata. Devices MUST NOT advertise features they implement only for a subset of otherwise-valid
inputs unless that limitation is itself defined and advertised by the feature's specification.

An implementation is considered **Opalinx** 1.0 conformant if it:

- Recognizes all standard request messages and supports the mandatory baseline above.
- Device implementations use the exact rejection precedence defined in
  [Receiver Framing and Recovery](#receiver-framing-and-recovery); host implementations satisfy its
  safe-acceptance requirements without needing the same internal check order.
- Implements the session-boundary cleanup and persistent device state defined in
  [Connection and session boundaries](#connection-and-session-boundaries).
- Silently discards oversized, undecodable, short, and checksum-invalid candidates without affecting
  the state of prior valid messages; sends exactly one appropriate `ERROR` for other rejected requests
  with a nonzero transaction ID.
- Responds to `Request Device Information` with a properly formatted `INFO` response containing
  all required fields.
- Responds to `Request Device Configuration` with a properly formatted `CONFIG` response.
- Responds to `Configure Device` with a `CONFIG` response on success or an appropriate `ERROR`
  response on failure; on success, clears the pixel buffer of every affected channel to all-zeros
  atomically (for broadcast, either all channels are updated or none).
- Responds to `Reset` with a `RESET_ACK` response after LED transmission completes, and rejects a
  `Reset` received during active transmission with `ERR_BUSY`.
- Implements the one-Show backlog, admission, frame-protection, completion, and acknowledgement
  guarantees defined in [Frame Pipelining](#frame-pipelining).
- Sends `SET_PIXELS_ACK`, `FILL_CHANNEL_ACK`, and `SHOW_ACK` responses for pixel and show
  operations received with `TxID ≠ 0x0000`.
- Applies all field-specific reserved and unknown-value rules.
- Recognizes the namespaced vendor envelope and returns `ERR_UNSUPPORTED` for an unimplemented
  namespace or command.
- Rejects identifiers in reserved request ranges with `ERR_UNKNOWN_IDENTIFIER`.


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
