(function () {
  window.alert = function () {};
  window.confirm = function () {
    return true;
  };
})();
