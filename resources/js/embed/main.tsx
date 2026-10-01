/**
 * Entry of the chat panel that runs inside the widget iframe (`/embed/{key}`).
 * Placeholder until P4 (chat core) builds the real panel; P3 only needs the entry to exist
 * so the Blade shell, CSP and loader <-> iframe handshake can be built and tested.
 */
const root = document.getElementById('chat-root');

if (root !== null) {
    root.textContent = 'Chat panel (coming in P4)';
}
