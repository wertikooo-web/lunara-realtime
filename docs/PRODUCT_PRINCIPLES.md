# Product Principles

## Separate Product Line

Lunara Realtime is a separate device line. It is not a replacement for the base Lunara toy and must not be developed as a hidden migration branch for the existing product.

The base Lunara device continues to evolve in its own repository and keeps its current request/response architecture.

## Realtime First

This product starts from a different assumption: the child should feel that the device is listening and responding in a continuous conversation.

Core principles:

- full-duplex audio where possible
- low time to first audio
- interruption support
- short conversational latency
- clear online/offline state
- graceful degradation when realtime providers fail

## Device First

The server architecture must be shaped by the physical device:

- microphone behavior
- speaker behavior
- Wi-Fi stability
- memory limits
- battery and heat constraints
- child-safe recovery after network loss

## No Production Coupling

Do not import modules from the base Lunara server.

Do not share runtime state, database tables, content cache, parent panel routes, or firmware assumptions unless a future integration document explicitly approves that boundary.

## Safety

Use synthetic audio and test phrases during R&D. Do not store real child recordings in this lab.

