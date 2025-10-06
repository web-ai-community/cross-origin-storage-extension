const cachePromise = caches.open('cos-storage');
let cache;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { target, action, data } = message;
  (async () => {
    // Return early if this message isn't meant for the offscreen document.
    if (target !== 'offscreen-doc') {
      return;
    }
    cache = await cachePromise;
    switch (action) {
      case 'getBlobURL':
        const response = await cache.match(data.key);
        const blob = await response.blob();
        const blobURL = URL.createObjectURL(blob);
        sendResponse({
          data: {
            blobURL,
          },
        });
        break;
      case 'getResourceSize':
        const sizeResponse = await cache.match(
          `https://cos.example.com/SHA-256_${data.hash}`
        );
        if (sizeResponse) {
          const sizeBlob = await sizeResponse.blob();
          sendResponse({ data: { size: sizeBlob.size } });
        } else {
          // If the resource is not in the cache, return null.
          sendResponse({ data: { size: null } });
        }
        break;
      case 'deleteResource':
        await cache.delete(`https://cos.example.com/SHA-256_${data.hash}`);
        sendResponse({
          data: {
            success: true,
          },
        });
        break;
      case 'deleteAllResources':
        const keys = await cache.keys();
        for (const key of keys) {
          await cache.delete(key);
        }
        sendResponse({
          data: {
            success: true,
          },
        });
        break;
      default:
        console.warn('Unknown action:', action);
    }
  })();
  return true;
});
