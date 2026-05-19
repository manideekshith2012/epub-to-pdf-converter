const form = document.querySelector("#converterForm");
const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const dropTitle = document.querySelector("#dropTitle");
const dropHint = document.querySelector("#dropHint");
const convertButton = document.querySelector("#convertButton");
const pageSize = document.querySelector("#pageSize");
const fontSize = document.querySelector("#fontSize");
const marginSize = document.querySelector("#marginSize");
const statusText = document.querySelector("#statusText");
const progressBar = document.querySelector("#progressBar");
const fileName = document.querySelector("#fileName");
const bookTitle = document.querySelector("#bookTitle");
const chapterCount = document.querySelector("#chapterCount");
const downloadLink = document.querySelector("#downloadLink");

let selectedFile = null;
let selectedFileBuffer = null;

const parser = new DOMParser();

fileInput.addEventListener("change", async () => {
  await setFile(fileInput.files[0]);
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
}

dropZone.addEventListener("drop", async (event) => {
  await setFile(event.dataTransfer.files[0]);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!selectedFile || !selectedFileBuffer) return;

  try {
    setBusy(true);
    setProgress(6, "Reading EPUB package...");
    const book = await readEpub(selectedFileBuffer);

    bookTitle.textContent = book.title || "Untitled book";
    chapterCount.textContent = String(book.sections.length);

    setProgress(42, "Extracting chapter text...");
    const pages = await collectPages(book);

    setProgress(72, "Building PDF...");
    const pdfBlob = buildPdf({
      title: book.title || stripExtension(selectedFile.name),
      author: book.author,
      pages,
    });

    const url = URL.createObjectURL(pdfBlob);
    downloadLink.href = url;
    downloadLink.download = `${safeFileName(book.title || stripExtension(selectedFile.name))}.pdf`;
    downloadLink.hidden = false;

    setProgress(100, "PDF ready to download.");
  } catch (error) {
    console.error(error);
    setProgress(0, error.message || "Could not convert this EPUB.");
    downloadLink.hidden = true;
  } finally {
    setBusy(false);
  }
});

async function setFile(file) {
  if (!file) return;

  resetSelectedFile(file);
  setBusy(true);
  setProgress(3, "Reading selected EPUB...");

  try {
    selectedFileBuffer = await file.arrayBuffer();
    convertButton.disabled = false;
    setProgress(0, "Ready to convert.");
  } catch (error) {
    console.error(error);
    selectedFile = null;
    selectedFileBuffer = null;
    convertButton.disabled = true;
    setProgress(0, "The selected EPUB could not be read. Try moving it to a local folder and selecting it again.");
  } finally {
    setBusy(false);
  }
}

function resetSelectedFile(file) {
  selectedFile = file;
  selectedFileBuffer = null;
  convertButton.disabled = true;
  downloadLink.hidden = true;
  fileName.textContent = file.name;
  bookTitle.textContent = "Not read yet";
  chapterCount.textContent = "0";
  dropTitle.textContent = file.name;
  dropHint.textContent = `${formatBytes(file.size)} selected`;
}

function setBusy(isBusy) {
  convertButton.disabled = isBusy || !selectedFileBuffer;
  convertButton.textContent = isBusy ? "Converting..." : "Convert to PDF";
}

function setProgress(value, message) {
  progressBar.style.width = `${value}%`;
  statusText.textContent = message;
}

async function readEpub(file) {
  ensureLibraries();

  const zip = await JSZip.loadAsync(file);
  const containerFile = zip.file("META-INF/container.xml");

  if (!containerFile) {
    throw new Error("This file is missing the EPUB container.");
  }

  const container = parseXml(await containerFile.async("text"));
  const rootfile = firstByLocalName(container, "rootfile");
  const opfPath = rootfile?.getAttribute("full-path");

  if (!opfPath) {
    throw new Error("This EPUB does not point to a package document.");
  }

  const packageFile = zip.file(opfPath);

  if (!packageFile) {
    throw new Error("The EPUB package document could not be found.");
  }

  const packageXml = parseXml(await packageFile.async("text"));
  const basePath = directoryName(opfPath);
  const manifest = new Map();
  const manifestElement = firstByLocalName(packageXml, "manifest");
  const spineElement = firstByLocalName(packageXml, "spine");

  for (const item of childrenByLocalName(manifestElement, "item")) {
    manifest.set(item.getAttribute("id"), {
      href: item.getAttribute("href"),
      mediaType: item.getAttribute("media-type"),
    });
  }

  const sections = childrenByLocalName(spineElement, "itemref")
    .map((itemRef) => manifest.get(itemRef.getAttribute("idref")))
    .filter(Boolean)
    .filter((item) => /xhtml|html/i.test(item.mediaType || item.href || ""))
    .map((item) => normalizePath(`${basePath}/${item.href}`));

  if (!sections.length) {
    throw new Error("No readable chapter files were found in this EPUB.");
  }

  return {
    zip,
    basePath,
    title: metadataText(packageXml, "title"),
    author: metadataText(packageXml, "creator"),
    sections,
  };
}

async function collectPages(book) {
  const pages = [];

  for (let index = 0; index < book.sections.length; index += 1) {
    const sectionPath = book.sections[index];
    const file = book.zip.file(sectionPath);

    if (!file) continue;

    setProgress(42 + Math.round((index / book.sections.length) * 26), `Reading chapter ${index + 1}...`);
    const html = await file.async("text");
    const doc = parser.parseFromString(html, "text/html");
    const title = firstText(doc, "h1, h2, h3") || `Chapter ${index + 1}`;
    const blocks = Array.from(doc.body.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,pre"))
      .map((node) => cleanText(node.textContent))
      .filter(Boolean);

    if (blocks.length) {
      pages.push({ title: cleanText(title), blocks });
    }
  }

  if (!pages.length) {
    throw new Error("No readable text was found in this EPUB.");
  }

  return pages;
}

function buildPdf({ title, author, pages }) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({
    unit: "pt",
    format: pageSize.value,
    compress: true,
  });

  const margin = Number(marginSize.value);
  const bodySize = Number(fontSize.value);
  const lineHeight = bodySize * 1.45;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  pdf.setProperties({
    title,
    author: author || "",
    creator: "EPUB to PDF Converter",
  });

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(20);
  y = drawWrapped(pdf, title, margin, y, maxWidth, 24);

  if (author) {
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(12);
    y = drawWrapped(pdf, `by ${author}`, margin, y + 8, maxWidth, 18);
  }

  y += 24;

  for (const page of pages) {
    if (y > pageHeight - margin * 3) {
      pdf.addPage();
      y = margin;
    }

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(bodySize + 4);
    y = drawWrapped(pdf, page.title, margin, y, maxWidth, lineHeight + 4);
    y += 6;

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(bodySize);

    for (const block of page.blocks) {
      const lines = pdf.splitTextToSize(block, maxWidth);

      if (y + lines.length * lineHeight > pageHeight - margin) {
        pdf.addPage();
        y = margin;
      }

      pdf.text(lines, margin, y);
      y += lines.length * lineHeight + bodySize * 0.75;
    }
  }

  return pdf.output("blob");
}

function drawWrapped(pdf, text, x, y, width, lineHeight) {
  const lines = pdf.splitTextToSize(text, width);
  pdf.text(lines, x, y);
  return y + lines.length * lineHeight;
}

function ensureLibraries() {
  if (!window.JSZip || !window.jspdf?.jsPDF) {
    throw new Error("Conversion libraries are still loading. Please try again in a moment.");
  }
}

function parseXml(xml) {
  const doc = parser.parseFromString(xml, "application/xml");

  if (doc.querySelector("parsererror")) {
    throw new Error("Could not read the EPUB XML.");
  }

  return doc;
}

function textFrom(doc, selector) {
  return cleanText(doc.querySelector(selector)?.textContent || "");
}

function metadataText(doc, name) {
  const metadata = firstByLocalName(doc, "metadata");
  return cleanText(firstByLocalName(metadata, name)?.textContent || "");
}

function firstByLocalName(root, name) {
  return root ? Array.from(root.getElementsByTagName("*")).find((node) => node.localName === name) : null;
}

function childrenByLocalName(root, name) {
  return root ? Array.from(root.children).filter((node) => node.localName === name) : [];
}

function firstText(doc, selector) {
  return cleanText(doc.querySelector(selector)?.textContent || "");
}

function cleanText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function directoryName(filePath) {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/");
}

function normalizePath(value) {
  const parts = [];

  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  return parts.join("/");
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, "");
}

function safeFileName(name) {
  return stripExtension(name)
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "converted-book";
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
