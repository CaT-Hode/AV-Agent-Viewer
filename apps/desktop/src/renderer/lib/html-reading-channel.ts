type ReadingMessage = Record<string, unknown>;
type Options = {
  token: string;
  source(): MessageEventSource | null | undefined;
  onMessage(message: ReadingMessage): void;
  onReady?(): void;
  onDisconnect?(): void;
};

/** WindowProxy authenticates only the initial transferred port, never commands. */
export function createHtmlReadingChannel(options: Options) {
  let port: MessagePort | undefined, disposed = false;
  const release = (notify: boolean) => {
    const previous = port; port = undefined;
    if (previous) { previous.onmessage = null; previous.onmessageerror = null; previous.close(); if (notify) options.onDisconnect?.(); }
  };
  const post = (message: ReadingMessage) => {
    if (!port || disposed) return false;
    try { port.postMessage(message); return true; }
    catch { release(true); return false; }
  };
  return {
    receiveHandshake(event: MessageEvent): boolean {
      if (event.data?.type !== 'agentviewer-html-channel') return false;
      const source = options.source();
      if (disposed || !source || event.source !== source || event.data.token !== options.token || event.ports.length !== 1) {
        for (const incoming of event.ports) incoming.close();
        return false;
      }
      const incoming = event.ports[0]; release(false); port = incoming;
      incoming.onmessage = event => {
        if (disposed || port !== incoming || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
        if (event.data.type === 'agentviewer-html-channel-close') { release(true); return; }
        if (event.data.type === 'agentviewer-html-context' || event.data.type === 'agentviewer-html-navigation-error') options.onMessage(event.data as ReadingMessage);
      };
      incoming.onmessageerror = () => { if (port === incoming) release(true); };
      incoming.start();
      if (!post({ type: 'agentviewer-html-channel-ready' })) return false;
      options.onReady?.();
      return true;
    },
    post,
    reset() { release(false); },
    close() { disposed = true; release(false); },
  };
}

/** Runs inside the sanitized srcDoc. Its port belongs to that document realm. */
export function htmlReadingChannelScript(token: string) {
  const nonce = JSON.stringify(token).replace(/</g, '\\u003c');
  return `let readingPort,readingChannelReady=false,readingChannelStopped=false,readingHandshakeTimer,readingHandshakeAttempts=0;
    const postReadingMessage=message=>{if(!readingChannelReady||!readingPort)return false;readingPort.postMessage(message);return true;};
    const connectReadingChannel=()=>{
      if(readingChannelStopped||readingChannelReady||readingHandshakeAttempts++>=64)return;
      readingPort?.close();const channel=new MessageChannel(),local=channel.port1;readingPort=local;
      local.onmessage=event=>{
        if(readingChannelStopped||readingPort!==local)return;
        if(event.data?.type==='agentviewer-html-channel-ready'){
          if(readingChannelReady)return;readingChannelReady=true;clearTimeout(readingHandshakeTimer);send();
        }else if(readingChannelReady)navigateHtml(event.data);
      };
      local.start();parent.postMessage({type:'agentviewer-html-channel',token:${nonce}},'*',[channel.port2]);
      readingHandshakeTimer=setTimeout(connectReadingChannel,150);
    };
    addEventListener('message',event=>{if(event.source!==parent||event.data?.type!=='agentviewer-html-channel-request')return;readingChannelStopped=false;readingChannelReady=false;readingHandshakeAttempts=0;clearTimeout(readingHandshakeTimer);connectReadingChannel();});
    addEventListener('pagehide',()=>{readingChannelStopped=true;clearTimeout(readingHandshakeTimer);postReadingMessage({type:'agentviewer-html-channel-close'});readingChannelReady=false;readingPort?.close();readingPort=undefined;});
    connectReadingChannel();`;
}
