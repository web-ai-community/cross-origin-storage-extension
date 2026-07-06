# Cross-Origin Storage extension

<img src="https://raw.githubusercontent.com/web-ai-community/cross-origin-storage-extension/refs/heads/main/logo-cos.svg" alt="Cross-Origin Storage API logo" width="60" height="60">

## Usage

1. Choose between the developer or the end user flow:
   - Developer:
     - Clone the repo or download the files manually.
     - Run `npm install` once (wires up the pre-commit hook via the
       `prepare` script).
     - Load the extension unpacked from the subfolder matching your browser
       (`chrome/`, `firefox/`, or `safari/`) as per the
       [Load an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
       instructions (Firefox: `about:debugging` → **Load Temporary Add-on**;
       Safari 18+: Develop menu → **Allow Unsigned Extensions**, then add the
       extension). Each subfolder is a self-contained checkout of the shared
       source files (via symlinks) plus that browser's own generated
       `manifest.json`, so editing a shared file at the repo root updates
       all three at once. Don't hand-edit anything inside `chrome/`,
       `firefox/`, or `safari/` directly — `manifest.json` in each is
       generated from `manifest.base.json` + `manifest.<browser>.diff.json`
       (run `npm run sync` once, or `npm run watch` to regenerate live while
       you edit; a commit also regenerates it automatically via the
       pre-commit hook).
   - End user:
     - Install the extension from the
       [Chrome Web Store](https://chromewebstore.google.com/detail/cross-origin-storage/denpnpcgjgikjpoglpjefakmdcbmlgih).
1. Navigate to the demo app on
   [https://web-ai-community.github.io](https://web-ai-community.github.io/cross-origin-storage-extension/)
   (or try the more realistic
   [Hugging Face Whisper example](https://web-ai-community.github.io/cross-origin-storage-extension/huggingface.html)
   on that origin).
1. Press the **Analyze sentiment** button.
1. Navigate to the same demo app but hosted on the different origin
   [https://googlechrome.github.io](https://googlechrome.github.io/samples/cos-demo/)
   (or try the more realistic
   [Hugging Face Whisper example](https://googlechrome.github.io/samples/cos-demo/huggingface.html)
   on that different origin).
1. Press the **Analyze sentiment** button. Now the resource with the SHA-256
   hash `0fb85c8c503d43711cf821d5629ac17fecaf1a3e98517c73038e72105aaf56d9` is
   already in Cross-Origin Storage 🎉.
1. Click the extension icon to see stats about the different resources and
   origins.

   <img width="631" height="757" alt="Image" src="https://github.com/user-attachments/assets/5554f89e-dd7d-478e-8cf9-edccc5a5a0c4" />

## License

Apache 2.0.
