# Cross-Origin Storage extension

<img src="https://raw.githubusercontent.com/web-ai-community/cross-origin-storage-extension/refs/heads/main/logo-cos.svg" alt="Cross-Origin Storage API logo" width="60" height="60">

## Usage

1. Clone the repo or download the files manually.
1. Install the extension as per the
   [Load an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
   instructions.
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
1. Click the extenision icon to see stats about the different resources and
   origins.

   <img width="631" height="757" alt="Image" src="https://github.com/user-attachments/assets/5554f89e-dd7d-478e-8cf9-edccc5a5a0c4" />

## License

Apache 2.0.
