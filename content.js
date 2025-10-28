// Inject the main-world.js script into the page's context.
const script = document.createElement('script');
script.src = chrome.runtime.getURL('main-world.js');
script.onload = function () {
  this.remove();
};
(document.head || document.documentElement).appendChild(script);

// Listen for messages from the MAIN world script.
window.addEventListener('message', async (event) => {
  // Only accept messages from the extension itself.
  if (
    event.source !== window ||
    event.data.source !== 'cos-polyfill-main' ||
    !event.data.id
  ) {
    return;
  }
  const { id, action, data } = event.data;

  if (data.data) {
    // Send data as Blob URL.
    const blob = new Blob([data.data], {
      type: data.data.type || 'application/octet-stream',
    });
    data.blobURL = URL.createObjectURL(blob);
    delete data.data;
  }
  // Forward the message to the background script
  chrome.runtime.sendMessage({ action, data }, async (response) => {
    if (response.data.blobURL) {
      // Send Blob URL as ArrayBuffer.
      response.data.data = await fetch(response.data.blobURL).then((response) =>
        response.arrayBuffer()
      );
    }
    window.postMessage(
      {
        source: 'cos-polyfill-isolated',
        id: id,
        data: response.data,
      },
      event.origin
    );
  });
});
