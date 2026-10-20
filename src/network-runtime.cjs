/** Configure Chromium before app readiness or creation of any renderer.
 * @param {Electron.App} app */
function configureNetworkRuntime(app) {
  if (process.platform !== 'darwin') return;
  // GLKVM connects to configured KVM origins, which already know the client's
  // LAN address. Use direct host ICE candidates instead of publishing synthetic
  // .local names. On macOS, closing Chromium's MdnsResponderManager sockets can
  // stall inside guarded_close_np, blocking the network service and configd.
  // Unloading pages / closeAllConnections cannot close these UDP sockets:
  // their manager lives until its NetworkContext is destroyed.
  // Chromium 156: PeerConnectionDependencyFactory::CreatePeerConnectionFactory
  // gates MdnsResponderAdapter creation on WebRtcHideLocalIpsWithMdns:
  // https://github.com/chromium/chromium/blob/156.0.8078.36/third_party/blink/renderer/modules/peerconnection/peer_connection_dependency_factory.cc#L795-L803
  const disabled = new Set(app.commandLine.getSwitchValue('disable-features').split(',').filter(Boolean));
  disabled.add('WebRtcHideLocalIpsWithMdns');
  app.commandLine.appendSwitch('disable-features', [...disabled].join(','));
}

module.exports = { configureNetworkRuntime };
