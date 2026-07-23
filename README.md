# OPAL - Open Protocol for Addressable LEDs
### Version: 1.0.0 (Draft)

> [!WARNING]
> **OPAL 1.0 is a Draft.** The `1.0.0` number is the target wire contract, but the specification is
> still being stabilized and breaking changes may occur before it is frozen. Implementations remain
> pre-1.0 until then; see [`../VERSIONING.md`](../VERSIONING.md) for how the protocol, firmware, and
> library versions relate.

**OPAL** is a lightweight binary protocol that allows interfacing with compatible LED controllers 
over a reliable byte stream (typically, serial over USB).


## Scope

**OPAL** targets one-wire, addressable-LED chips in the **WS281x** family, including **WS2811**,
**WS2812**, **WS2812B**, **WS2813**, and their variants (e.g., **WS2814**, **WS2815**, **SK6812**). 
Both 3-component (RGB) and 4-component (RGBW) chips are supported.

> [!NOTE]
> Two-wire protocols such as **APA102** (DotStar) and **WS2801** are not currently in scope for
> this specification.

**OPAL** assumes the transport is trusted and delivers bytes in order without loss. It does not 
define reliability, authentication, network addressing, or fixture personality modeling.


## Conventions

- **Key words**: **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used as
  defined in [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

- **Byte order**: All multi-byte integer fields are little-endian.

- **Strings**: UTF-8 encoded with a length prefix, not null-terminated.

- **Reserved fields and bits**: Senders MUST set them to zero; receivers MUST ignore their
  contents.

- **Versioning**: [Semantic versioning](https://semver.org/) is used (major version updates
  indicate breaking changes; minor version updates add features without breaking existing clients).


## General Message Format

All **OPAL** messages, whether sent by a host (request) or by a device (response), share the 
following unencoded structure:

| TRANSACTION ID | MESSAGE IDENTIFIER   | PAYLOAD LENGTH | PAYLOAD  | CHECKSUM |
|----------------|----------------------|----------------|----------|----------|
| 2 bytes        | 1 byte               | 2 bytes        | variable | 2 bytes  |

**OPAL** frames are encoded with 
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
integer). **OPAL** implementations MUST support at least 4101 bytes of payload, sufficient to
accommodate 1365 RGB or 1024 RGBW LEDs per `Set Pixels` message. Each device advertises its actual 
buffer capacity in the `max_payload_length` field of the `INFO` response; clients MUST NOT send a 
payload exceeding the advertised value. Devices MUST reject frames exceeding their capacity with
`ERR_INVALID_PAYLOAD_LENGTH`. After COBS encoding, a frame grows by at most one byte per 254 bytes 
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

**OPAL** 1.0 assumes a reliable, ordered, single-client transport. Hosts correlate responses to
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
`TxID = 0x0000` is recommended to avoid ACK overhead.

### Frame Pipelining

Frame transmission on **WS281x** LEDs takes a fixed, comparatively long time. The duration for one
channel is:

```text
bits_per_led       = components_per_led × 8
data_time          = LED_count × bits_per_led × bit_period
frame_time         = data_time + reset_time
minimum_reset_time = 300 µs
```

The protocol values defined by OPAL use a `1.25 µs` bit period at 800 kHz and a `2.5 µs` bit period
at 400 kHz. Therefore, excluding the reset interval, one RGB LED takes approximately `30 µs` at
800 kHz or `60 µs` at 400 kHz; one RGBW LED takes approximately `40 µs` at 800 kHz or `80 µs` at
400 kHz. For a broadcast `Show`, all channels start together and the physical operation completes
when the slowest affected channel completes, so its duration is the maximum `frame_time` across the
affected channels, not the sum of their durations.

A host that waits for `SHOW_ACK` before issuing the next `Show` (the lock-step pattern above) leaves
the device idle for one host round-trip at every frame boundary, because the device cannot begin the
next frame until a new `Show` arrives. Frame pipelining removes that idle gap by letting the host
queue the next `Show` while the current frame is still transmitting.

**Frame pipelining is a mandatory part of OPAL.** Every conformant device supports a one-deep `Show`
queue, so a host can always pipeline without negotiating a capability first — pipelining is never
rejected and is never slower than lock-step. This universality is deliberate: it lets host libraries
keep the transmission pipe full by default rather than treating high throughput as an optional
extra.

In OPAL 1.0 the pipeline depth is exactly `2`: one actively transmitting `Show` plus one queued
`Show`. A device MUST report `max_in_flight_frames = 2` in its [`INFO`](#info-0x81) response, and a
host MUST reject any other reported value as incompatible. Whether pipeline depth should remain an
advertised field in a later draft revision is intentionally separate from the OPAL 1.0 wire-layout
requirement defined here.

**Device behavior (mandatory).** Every conformant device MUST tolerate exactly one queued broadcast
`Show`:

- A broadcast `Show` that arrives while the device is transmitting a previous frame, and while no
  other `Show` is already queued, MUST be accepted (not rejected with `ERR_BUSY`). The device MUST
  begin transmitting the queued frame as soon as the current frame completes, including the
  inter-frame reset period.
- A `Show` that arrives while a `Show` is already queued MUST be rejected with `ERR_BUSY`. This
  bounds the device to a single queued frame.
- Holding a queued frame while transmitting the current one implies at least one frame of buffering
  ahead of the output (double buffering). This is the one hardware requirement pipelining places on
  a conformant device; it is inexpensive for any practical **WS281x** controller.
- A device MAY satisfy the requirement by serializing — accepting the queued `Show` but not
  overlapping any preparation with reception. Such a device is fully conformant; it simply gains no
  throughput benefit. A device that overlaps preparation and transmission of the queued frame with
  continued reception of the next frame's data obtains the full benefit. The wire-visible behaviour
  is identical either way, so the host treats all conformant devices the same and never needs to
  distinguish them.

The device samples a queued frame's channel buffers when it begins transmitting that frame, not
when the `Show` is queued. A device MAY reject `Set Pixels`, `Fill Channel`, or `Configure Device`
messages that arrive while a `Show` is queued with `ERR_BUSY`, since such messages would otherwise
overwrite the queued frame's not-yet-sampled buffers.

**Host discipline.** A pipelining host keeps at most one `Show` queued beyond the transmitting frame
and MUST use a non-zero `TxID` on every pipelined `Show` so it can track completion. Having sent
`Show` for frame *N+1* while frame *N* is still transmitting, the host MUST NOT send any
`Set Pixels`, `Fill Channel`, or `Configure Device` for a later frame until it has received
`SHOW_ACK` for frame *N*. That acknowledgement is emitted when frame *N*'s transmission completes and
frame *N+1* has been committed to hardware, so it guarantees frame *N+1*'s buffers have been sampled
and are safe to overwrite. This rule bounds the host to a single queued `Show` and keeps the
acknowledgement round-trip off the critical path, since the next `Show` is already waiting in the
device when the current frame finishes.

The pixel traffic itself stays fire-and-forget: `Set Pixels` and `Fill Channel` use `TxID = 0x0000`
and are never acknowledged. Only the frame-boundary `Show` carries a non-zero `TxID`; that single
lightweight acknowledgement per frame is the host's pacing and buffer-safety signal. A lagging
`SHOW_ACK` stream is therefore the backpressure signal: if acknowledgements fall behind, the host is
outrunning the device and MUST stop queuing further `Show` messages until the outstanding
acknowledgement arrives, rather than risk `ERR_BUSY`.

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
| Protocol version major  | 1 byte   | Major version of the **OPAL** protocol                      |
| Protocol version minor  | 1 byte   | Minor version of the **OPAL** protocol                      |
| Protocol version patch  | 1 byte   | Patch version of the **OPAL** protocol                      |
| Channel count           | 1 byte   | Number of LED channels (`N`) supported by the device        |
| Capability flags        | 4 bytes  | Bitfield, little-endian; see capability bits below          |
| Firmware version major  | 1 byte   | Device firmware major version                               |
| Firmware version minor  | 1 byte   | Device firmware minor version                               |
| Firmware version patch  | 1 byte   | Device firmware patch version                               |
| Max payload length      | 2 bytes  | Max accepted payload, in bytes, little-endian; MUST be ≥ 4101 |
| Max in-flight frames    | 1 byte   | Number of outstanding `Show` operations accepted; MUST be `2` in OPAL 1.0 |
| Max LEDs (RGB)          | 2 bytes  | Max LEDs per channel in a 3-component order, little-endian; `0` = not advertised |
| Max LEDs (RGBW)         | 2 bytes  | Max LEDs per channel in a 4-component order, little-endian; `0` = not advertised |
| Device name length      | 1 byte   | Length in bytes of the following UTF-8 string               |
| Device name             | variable | UTF-8 encoded, not null-terminated                          |
| Hardware revision length | 1 byte  | Length in bytes of the following UTF-8 string (`1`–`63`)    |
| Hardware revision       | variable | Manufacturer-defined hardware revision                      |
| Hardware platform length | 1 byte  | Length in bytes of the following UTF-8 string (`1`–`63`)    |
| Hardware platform       | variable | Processor, module, or execution platform used by the device |
| Transport length        | 1 byte   | Length in bytes of the following UTF-8 identifier (`1`–`63`) |
| Transport               | variable | Active transport carrying this OPAL connection              |

`max_in_flight_frames` reports the total number of `Show` operations the device accepts before it
must reject another with `ERR_BUSY`: one actively transmitting plus
`max_in_flight_frames - 1` queued. In OPAL 1.0 this field MUST be exactly `2`. Hosts MUST decode the
field and MUST reject a device reporting any other value during compatibility validation. The
field's presence does not permit a deeper pipeline; deeper-pipeline buffer and acknowledgement
semantics are outside the scope of OPAL 1.0.

`max_leds_rgb` and `max_leds_rgbw` report the largest LED count the device accepts for one channel
configured with a 3-component or 4-component color order, respectively. These limits are not
derivable from `max_payload_length`: a device can buffer a full channel across multiple
`Set Pixels` messages, so its channel capacity can exceed the number of pixels carried by one
payload. A value of `0` means that the device does not advertise a limit for that component count.
Hosts MUST NOT infer a channel limit from `max_payload_length`; when the corresponding advertised
limit is zero, a host SHOULD attempt the desired `Configure Device` request and handle
`ERR_INVALID_PARAMETER` if the count exceeds the device's capacity.

A `device_name_length` of `0` is valid and indicates the device has no name; in this case the
`device_name` field is absent and `hardware_revision_length` immediately follows
`device_name_length`.

`hardware_revision`, `hardware_platform`, and `transport` are mandatory, non-empty UTF-8 strings
of at most 63 bytes.
When a device cannot determine its hardware revision, it MUST report `unknown`. The hardware
revision is manufacturer-defined; examples include `Rev A`, `1.2`, and `unknown`.

The `hardware_platform` field identifies the processor, module, or computing platform on which
the controller firmware runs. Examples include `ESP32-P4`, `Teensy 4.1`, and `RP2040`. It is
informational and does not imply particular capabilities; clients MUST accept and expose unknown
values. When a device cannot determine its platform, it MUST report `unknown`.

The `transport` field identifies the active transport carrying the current OPAL connection. It
does not identify intermediate adapters: a controller receiving OPAL through a UART reports
`uart`, even when the host reaches that UART through a USB-to-UART bridge. Standard transport
identifiers are lowercase ASCII:

| Identifier      | Transport                                      |
|-----------------|------------------------------------------------|
| `uart`          | Hardware UART                                  |
| `usb-cdc`       | USB Communications Device Class serial         |
| `tcp`           | Transmission Control Protocol                  |
| `udp`           | User Datagram Protocol                         |
| `bluetooth-spp` | Bluetooth Serial Port Profile / RFCOMM         |
| `bluetooth-le`  | Bluetooth Low Energy                           |

Future specifications may define additional identifiers. Vendor-defined transports SHOULD use a
namespaced identifier such as `vendor.example/custom-link`. Clients MUST accept and expose unknown
transport identifiers and MUST NOT reject a device because its transport is unrecognized. The
transport string identifies the binding only; it MUST NOT contain link speed, driver, adapter, or
other diagnostic details.

**Capability flags** (bit positions within the 32-bit little-endian field):

| Bit  | Name                     | Meaning                                                        |
|------|--------------------------|----------------------------------------------------------------|
| 0    | `CAP_RGBW`               | Device supports 4-component (RGBW) color orders                |
| 1    | `CAP_PER_CHANNEL_CONFIG` | Device supports per-channel configuration                      |
| 2    | `CAP_PER_CHANNEL_SHOW`   | Device supports per‑channel Show                               |
| 3–31 | Reserved                 | MUST be `0` in senders; MUST be ignored by receivers           |

Clients MUST ignore unknown capability bits to remain forward-compatible.

The mandatory one-deep `Show` queue is **not** a capability bit. Every conformant device reports
`max_in_flight_frames = 2` and supports one actively transmitting plus one queued `Show` (see
[Frame Pipelining](#frame-pipelining)). The field is part of the fixed INFO wire layout, but it does
not negotiate a different depth in OPAL 1.0.

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

- A `Show` request MUST be accepted and queued if no `Show` is already queued, and MUST be rejected
  with `ERR_BUSY` only if a `Show` is already queued. See [Frame Pipelining](#frame-pipelining) for
  the full one-deep queue semantics.
- A `Reset` request MUST be rejected with `ERR_BUSY`. `Reset` is a management command, not a
  streaming operation, and is not queued.
- Devices MAY reject `Set Pixels`, `Fill Channel`, or `Configure Device` messages with `ERR_BUSY`
  during active transmission, and MAY do so while a `Show` is queued to protect the queued frame's
  buffers (see [Frame Pipelining](#frame-pipelining)).

When `ERR_FRAMING_ERROR` is emitted, the transaction ID in the response MUST be `0x0000` and the
offending identifier MUST be `0x00`, as neither could be recovered from the malformed frame.

**OPAL** 1.0 uses the transaction ID echoed in every response — including `ERROR` responses — to
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

**OPAL** 1.0 is defined for reliable, ordered byte streams. The core **OPAL** frame format is
transport-agnostic, but it assumes the underlying transport delivers bytes in order and without
loss.

The message framing described in this document applies directly to transports such as USB serial,
UART, TCP, and Bluetooth RFCOMM/SPP.

Common transport bindings:

- **USB serial / UART**: **OPAL** frames are sent as a raw byte stream. COBS encoding plus `0x00`
  delimiter applies directly.
- **TCP / Ethernet over TCP**: **OPAL** frames may be transported unchanged over the TCP stream.
  TCP already provides reliability and ordering.
- **Bluetooth RFCOMM / SPP**: These transports also present a stream abstraction, so **OPAL** 
  framing applies directly.
- **Bluetooth LE (GATT)**: This is not a true byte stream; implementations MUST reassemble
  characteristic writes and notifications into a reliable ordered stream before decoding **OPAL**
  frames.
- **UDP**: **OPAL** does not assume an unordered, lossy packet transport. If UDP is used, each
  datagram MUST carry a complete **OPAL** frame and the binding MUST document loss, retransmission,
  and ordering behavior separately.

Implementations targeting non-stream transports MUST provide a transport binding that preserves
reliability and ordering, or MUST explicitly document the differences and any required recovery
semantics.

For unreliable transports, the application layer is responsible for retransmission and validation
of critical control and configuration messages. The protocol itself provides no built-in
retransmission mechanism; all reliability beyond the transport layer MUST be implemented by the
host application.

**Timeouts**: Hosts MUST implement a timeout when waiting for a response to messages that always
produce one (`Request Device Information`, `Request Device Configuration`, `Configure Device`,
and `Ping`). A suggested timeout is 1 second over USB serial; timeouts may be adjusted per
transport (e.g., longer for high-latency links like Bluetooth LE). When waiting for `SHOW_ACK` or
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

Future versions may define additional transport bindings for other reliable or packet-based
transports.


## Conformance

An implementation is considered **OPAL** 1.0 conformant if it:

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
- Tolerates a single queued broadcast `Show` per [Frame Pipelining](#frame-pipelining): accepts one
  `Show` received during active transmission and rejects a second queued `Show` with `ERR_BUSY`.
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

**OPAL** 1.0 provides no authentication, authorization, or encryption. It assumes the underlying
transport is trusted.

For USB serial connections this assumption is reasonable: physical access to the host is required
to open the port, which implies the ability to control any connected device.

For network transports (TCP, Bluetooth RFCOMM/SPP), the assumption does not hold automatically.
Any endpoint that can reach the device's network address or Bluetooth service can send arbitrary
**OPAL** commands — configuring channels, overwriting pixel buffers, and issuing resets — without
any credential. Deployments using these transports MUST secure the transport layer externally
(e.g., TLS for TCP, authenticated pairing for Bluetooth) or restrict access at the network or
OS level before exposing an **OPAL** device.

The CRC-16 checksum detects accidental bit errors in transit; it does not provide tamper
protection. An attacker with the ability to modify frames in transit can recompute a valid CRC
over altered data. **OPAL** offers no mechanism to detect or prevent deliberate tampering.


## Specification Governance

**OPAL** is a centrally governed protocol. The author and maintainer of this repository is the sole 
authority for publishing official versions of the **OPAL** specification.

Proposed changes, clarifications, and extensions may be submitted for discussion, but only versions
published by the official **OPAL** repository are considered authoritative.


## License Summary

OPAL is free to implement in software. You may create, distribute, sell, or commercially license 
software libraries, host applications, plugins, tools, test suites, tutorials, and integrations that
communicate with OPAL-compatible devices.

You may also implement OPAL in hardware or firmware for personal, educational, artistic, research, 
prototyping, and other non-commercial uses.

A separate commercial license is required to manufacture, sell, distribute, bundle, lease, rent, 
market, or otherwise commercialize hardware devices, firmware products, kits, modules, or 
installation systems that implement OPAL or advertise OPAL compatibility.

In short:

- commercial OPAL software is allowed;
- non-commercial OPAL hardware experimentation is allowed;
- commercial OPAL-compatible devices require a license;
- the official OPAL specification remains under the authority of Jean-Philippe
  Côté.

See [`LICENSE.md`](LICENSE.md) for the full legal text.


## Name Usage

The name "**OPAL**" refers exclusively to the protocol defined by the canonical specification.

Modified, extended, or incompatible protocols must not be described as **OPAL** or 
**OPAL**-compatible.

The name "**OPAL**" may only be used to refer to implementations or documents that conform to the 
official **OPAL** specification published by the author. 


## Contributing

Feedback, questions, and proposed extensions are welcome. Please open an issue on this repository
to discuss changes before submitting pull requests against the specification text.


## Author

OPAL was designed and authored by [Jean-Philippe Cô](https://djip.co), 2026.
