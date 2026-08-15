/* Wavelength Android bridge helpers. Safe no-op on normal browsers. */
(function(){
  window.WavelengthNative = {
    isAndroidApp: !!(window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'android'),
    plugins: function(){ return window.Capacitor?.Plugins || {}; }
  };
})();
