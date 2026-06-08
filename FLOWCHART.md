# Twilio & Firebase Secure Video Sync Flowchart

This document outlines the end-to-end user lifecycle, networking, authentication, token provisioning, and active state management of our video platform.

---

## ─── VISUAL STATE MACHINE Flowchart ───

```mermaid
graph TD
    %% Define Styles & Colors
    classDef auth fill:#1e1b4b,stroke:#6366f1,stroke-width:2px,color:#e0e7ff;
    classDef media fill:#020617,stroke:#10b981,stroke-width:2px,color:#ecfdf5;
    classDef server fill:#0f172a,stroke:#3b82f6,stroke-width:2px,color:#eff6ff;
    classDef firebase fill:#1c1917,stroke:#f59e0b,stroke-width:2px,color:#fffbeb;

    %% Workflow Stages
    A([User Opens App]) --> B{Is Authenticated?}
    
    %% Auth Branch
    B -- No --> C[Google Sign-In Button]:::auth
    C --> D[Firebase POPUP Auth Request]:::auth
    D --> E[Store Display Name & User ID]:::auth
    E --> B
    
    %% Lobby Setup (Green Room)
    B -- Yes --> F[Lobby & Green Room Entry]:::media
    F --> G[Initialize WebRTC Preview Stream]:::media
    G --> H{Grant Cam & Mic Access?}
    
    %% Media toggles
    H -- Allowed --> I[Show Live Video on Glass Canvas]:::media
    H -- Denied --> J[Show Initials Avatar & Friendly Alert Badge]:::media
    
    I & J --> K[Select Active Initial Toggles: Mic On/Off & Cam On/Off]:::media
    K --> L[Enter Room ID & Click 'Join Fully Secure']
    
    %% Token Exchange & Remote Signaling
    L --> M[Fetch /api/token via Express Proxy]:::server
    M --> N[Express Server verified via Twilio SDK]:::server
    N --> O[Generate cryptographically signed JWT Access Token]:::server
    O --> P[Client initialises Twilio Video Link]:::media
    
    %% Firestore Presence Logging & Live Frame
    P --> Q["Create /rooms/{roomID} on Firestore"]:::firebase
    Q --> R[Register Participant Presence document]:::firebase
    R --> S[Activate 10s Presence Heartbeat Interval]:::firebase
    
    %% Active Room Loop
    S --> T[Enter Shared Video Space Grid Layout]:::media
    T --> U[Track active duration stopwatch at top right]:::media
    T --> V[Mute, Unmute, or Screen Share during active session]:::media
    
    %% Leaving Hook
    V & U --> W[User Clicks 'End Call']
    W --> X[Delete Participant Firestore presence entry]:::firebase
    X --> Y[Disconnect Twilio Local Tracks & Audio Contexts]:::media
    Y --> Z([Return to Clean Lobby])
```

---

## ─── SYSTEM LIFECYCLE SCHEMATIC (ASCII Architecture) ───

```text
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CLIENT WEB BROWSER                                    │
│                                                                                         │
│  LOBBY SCREEN (Pre-Join / "Green Room")                                                 │
│  ┌────────────────────────────────────────────────────────┐                             │
│  │ 1. Firebase Auth Popup -> Authenticates user           │                             │
│  │ 2. WebRTC Preview Stream -> Pre-authenticates Cam/Mic  │                             │
│  │ 3. UI Toggles -> Initial Mic State  [On/Off]           │                             │
│  │                  Initial Cam State  [On/Off]           │                             │
│  └───────────────────────────┬────────────────────────────┘                             │
│                              │                                                          │
│                              │ (Rooms join requested)                                   │
│                              ▼                                                          │
│  JWT SIGNING TRANSACTION                                                                │
│  ┌────────────────────────────────────────────────────────┐                             │
│  │ 4. HTTP POST /api/token {identity, roomName}           ├──────────┐                  │
│  │                                                        │          │                  │
│  │ 5. Returns Signed JWT Token                           │◄─────────┼──────────┐       │
│  └───────────────────────────┬────────────────────────────┘          │          │       │
│                              │                                       │          │       │
│                              │ (Join Twilio Channel)                 │          │       │
│                              ▼                                       │          │       │
│  ACTIVE ROOM SPACE                                                   │          │       │
│  ┌────────────────────────────────────────────────────────┐          │          │       │
│  │ 6. Initialises SFU Peer Stream matching selection      │          │          │       │
│  │ 7. Periodically calls database heartbeat (10s)         │          │          │       │
│  │ 8. Manages live Stopwatch UI State & UI Stream updates │          │          │       │
│  └───────────────────────────┬────────────────────────────┘          │          │       │
│                              │                                       │          │       │
│                              │ (Clean-up on Leave)                   │          │       │
│                              ▼                                       │          │       │
│ ┌──────────────────────────────────────────────────────────┐         │          │       │
│ │ 9. Delete Presence Entry, Stop Local WebRTC Tracks       │         │          │       │
│ └──────────────────────────────────────────────────────────┘         │          │       │
└──────────────────────────────────────────────────────────────────────┼──────────┼───────┘
                                                                       │          │
                                                                       │          │
┌──────────────────────────────────────────────────────────────────────▼──────────┼───────┐
│                               DEVELOPMENT BACKEND SECURE HOST                   │       │
│                                                                                 │       │
│  EXPRESS APP API SERVERS                                                        │       │
│  ┌──────────────────────────────────────────────────────────────────────────────┴────┐  │
│  │ /api/token                                                                         │  │
│  │  - Receives Auth Verification Credentials                                          │  │
│  │  - Checks Sandbox Constraints                                                      │  │
│  │  - Signs JWT payload using Twilio SECRET parameters safely on backend host         │  │
│  └────────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                                                                  ▲
                                                                                  │
┌─────────────────────────────────────────────────────────────────────────────────┼───────┐
│                               PERSISTENT INFRASTRUCTURE SERVICES                │       │
│                                                                                 │       │
│  FIREBASE FIRESTORE                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────┘       │
│  │ Path: /rooms/{roomID}/participants/{identity}                                         │
│  │  - Synchronizes dynamic presence directories across remote team networks              │
│  │  - Clean schema defined by firebase-blueprint.json                                   │
│  │  - Secured safely by strict rules defined in firestore.rules                         │
│  └──────────────────────────────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## ─── RUNNING THE FLOW ───

1. **Gatekeeping via Google Provider**: Security check on client mount redirects unauthenticated views to authentication action (`signInWithGoogle`).
2. **WebRTC Access & "Green Room" Preview**: Eliminates sudden hardware shocks. Users can evaluate how their background looks without going to browser settings after joining a live session.
3. **Double Verification Heartbeat**: Active participants send automated Firestore update calls every 10 seconds.
4. **Clean Detachment Hook**: Leaving action executes both Twilio server disconnect and Firestore collection pruning synchronously to prevent lingering static profiles.
