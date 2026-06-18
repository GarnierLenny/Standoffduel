'use client';

import { useEffect, useRef, useState } from 'react';
import { SocketEvents } from '@standoffduel/shared';
import type { DuelSocket } from '@/lib/socket';

export interface WebRTCState {
  remoteStream: MediaStream | null;
  connected: boolean;
  error: string | null;
}

/**
 * Peer-to-peer webcam stream over `simple-peer`, with signaling relayed through
 * the socket. The server tells exactly one side to initiate (no glare); signals
 * that arrive before the peer exists are buffered.
 */
export function useWebRTC(
  socket: DuelSocket | null,
  localStream: MediaStream | null,
  initiator: boolean | null,
): WebRTCState {
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const peerRef = useRef<any>(null);
  const queueRef = useRef<unknown[]>([]);

  // Attach the signal relay listener as early as possible.
  useEffect(() => {
    if (!socket) return;
    const onSignal = (p: { signal: unknown }) => {
      if (peerRef.current) {
        try {
          peerRef.current.signal(p.signal);
        } catch {
          /* malformed signal - ignore */
        }
      } else {
        queueRef.current.push(p.signal);
      }
    };
    socket.on(SocketEvents.WebrtcSignal, onSignal);
    return () => {
      socket.off(SocketEvents.WebrtcSignal, onSignal);
    };
  }, [socket]);

  // Create the peer once we have a socket, a local stream and a role.
  useEffect(() => {
    if (!socket || !localStream || initiator === null || peerRef.current) return;
    let destroyed = false;

    (async () => {
      await import('@/lib/peer-polyfill');
      const SimplePeer = (await import('simple-peer')).default;
      if (destroyed) return;

      const peer = new SimplePeer({
        initiator,
        stream: localStream,
        trickle: false,
      });
      peerRef.current = peer;

      peer.on('signal', (data: unknown) => {
        socket.emit(SocketEvents.WebrtcSignal, { signal: data });
      });
      peer.on('stream', (stream: MediaStream) => setRemoteStream(stream));
      peer.on('connect', () => setConnected(true));
      peer.on('close', () => setConnected(false));
      peer.on('error', (e: Error) => setError(e.message));

      // Flush any signals that arrived before the peer existed.
      queueRef.current.forEach((sig) => {
        try {
          peer.signal(sig as Parameters<typeof peer.signal>[0]);
        } catch {
          /* ignore */
        }
      });
      queueRef.current = [];
    })();

    return () => {
      destroyed = true;
      if (peerRef.current) {
        try {
          peerRef.current.destroy();
        } catch {
          /* ignore */
        }
        peerRef.current = null;
      }
      setRemoteStream(null);
      setConnected(false);
    };
  }, [socket, localStream, initiator]);

  return { remoteStream, connected, error };
}
