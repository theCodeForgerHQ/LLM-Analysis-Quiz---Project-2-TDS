require("dotenv").config();
const express = require("express");
const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const {
  GoogleGenAI,
  createUserContent,
  createPartFromUri,
} = require("@google/genai");
const { exec } = require("child_process");

const app = express();
app.use(express.json());

const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);

function isFileUrl(u) {
  try {
    let pathname = new URL(u).pathname;
    pathname = pathname.replace(/\/+$/, "");
    const ext = path.extname(pathname).toLowerCase();
    return ext.length > 1;
  } catch {
    return false;
  }
}

async function downloadToDisk(url, filename) {
  while (true) {
    try {
      console.log("[DOWNLOAD] Downloading file:", url);
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 60000,
      });
      const savePath = path.join(downloadsDir, filename);
      fs.writeFileSync(savePath, res.data);
      console.log("[DOWNLOAD] Saved:", savePath);
      return savePath;
    } catch (e) {
      console.log("[DOWNLOAD] Failed, retrying...");
    }
  }
}

async function scrapePage(url) {
  console.log("[SCRAPER] Launching browser");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  const networkFiles = new Set();
  page.on("response", (response) => {
    try {
      const u = response.url();
      if (isFileUrl(u)) networkFiles.add(u);
    } catch {}
  });
  console.log("[SCRAPER] Navigating to:", url);
  await page.goto(url, { waitUntil: "networkidle0", timeout: 120000 });
  console.log("[SCRAPER] Extracting DOM");
  const data = await page.evaluate(() => {
    const abs = (href) => {
      try {
        return new URL(href, location.href).href;
      } catch {
        return null;
      }
    };
    const collect = (sel, attr) =>
      [...document.querySelectorAll(sel)]
        .map((el) => abs(el.getAttribute(attr)))
        .filter((x) => x);
    return {
      title: document.title,
      url: location.href,
      text: document.body ? document.body.innerText : "",
      html: document.documentElement ? document.documentElement.outerHTML : "",
      links: [...document.querySelectorAll("a")]
        .map((a) => abs(a.getAttribute("href")))
        .filter((x) => x),
      audio: collect("audio", "src"),
      video: collect("video", "src"),
      img: collect("img", "src"),
      source: collect("source", "src"),
      embed: collect("embed", "src"),
      objectData: collect("object", "data"),
      shadowContent: [...document.querySelectorAll("*")]
        .map((el) => (el.shadowRoot ? el.shadowRoot.innerHTML : null))
        .filter((x) => x),
    };
  });
  console.log("[SCRAPER] Closing browser");
  await browser.close();
  console.log("[SCRAPER] Done scraping");
  return { scraped: data, networkFiles: Array.from(networkFiles) };
}

function mimeFromName(name) {
  const ext = path.extname(name).toLowerCase();

  if ([".txt"].includes(ext)) return "text/plain";
  if ([".csv"].includes(ext)) return "text/csv";

  if ([".pdf"].includes(ext)) return "application/pdf";
  if ([".zip"].includes(ext)) return "application/zip";
  if ([".json"].includes(ext)) return "application/json";

  if ([".opus", ".mp3", ".wav", ".m4a"].includes(ext))
    return "audio/" + ext.replace(".", "");

  if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg";
  if ([".png"].includes(ext)) return "image/png";
  if ([".webp"].includes(ext)) return "image/webp";
  if ([".svg"].includes(ext)) return "image/svg+xml";

  if ([".mp4"].includes(ext)) return "video/mp4";
  if ([".webm"].includes(ext)) return "video/webm";

  return "application/octet-stream";
}

function buildQuestionPrompt(scraped, fileList, lastError) {
  const lines = [];
  lines.push("SCRAPED PAGE URL: " + scraped.url);
  lines.push("PAGE TITLE: " + (scraped.title || ""));
  lines.push("PAGE TEXT:\n" + (scraped.text || ""));
  lines.push("PAGE HTML:\n" + (scraped.html || ""));
  lines.push("LINKS:\n" + (scraped.links || []).join("\n"));
  lines.push("AUDIO LINKS:\n" + (scraped.audio || []).join("\n"));
  lines.push("VIDEO LINKS:\n" + (scraped.video || []).join("\n"));
  lines.push(
    "IMG/SOURCE/EMBED/OBJECT LINKS:\n" +
      [
        ...(scraped.img || []),
        ...(scraped.source || []),
        ...(scraped.embed || []),
        ...(scraped.objectData || []),
      ].join("\n")
  );
  lines.push(
    "SHADOW DOM CONTENTS:\n" + (scraped.shadowContent || []).join("\n\n")
  );
  lines.push(
    "FILES AVAILABLE:\n" + (fileList.length ? fileList.join("\n") : "NONE")
  );
  if (lastError)
    lines.push(
      "Previous attempt failed with error: " + String(lastError).slice(0, 1000)
    );
  lines.push(
    `
    You are given a webpage with its full content, including text, HTML, links, attachments (audio, CSV, or other files), and optionally an example submission JSON. Your task is to extract the *actual question* that the page is asking the user to solve and express it as a clean, fully readable, natural-language statement. Follow these instructions carefully.

    **Task Objective**: Produce a single, precise natural-language question that a human could understand without any additional context. The output must be deterministic: for the same input, your answer should be at least 95% consistent every time.

    **Rules and Step-by-Step Instructions**:

    1. **Ignore Submission JSON Structure**:  
    - The JSON provided on the page is only for submission.  
    - Do **not** reproduce it.  
    - You *may* use the value in the 'answer' field as a hint toward the actual question.

    2. **Include Attachments in Understanding**:  
    - If there is an audio file, fully transcribe it and use it to reconstruct the question.  
    - If there is a CSV, spreadsheet, or other dataset, use it *only* to infer what the question is asking (e.g., "sum values above threshold"). Do **not** include raw data in your output.

    3. **Answer Integration**:  
    - If the page itself provides the exact answer to the question, include it in the question using this format:  
        "What is X? (Answer: Y) No need of code block"
    - If the answer is not explicit, do not guess it.  
    - Do **not** include code instructions unless the answer is not directly available and the problem explicitly requires calculation or derivation.
    - Always include “No need of code” when the question can be answered without executing any computation, parsing, or aggregation.
    - Only omit “No need of code” if the question requires calculations or processing of data that cannot be done by reasoning alone.

    4. **Absolute URLs for References**:  
    - If the question references other pages, convert relative URLs to absolute URLs using the main page's URL. Include the full link in the question if needed for clarity.

    5. **Clarity and Readability**:  
    - Your output must be fully readable, grammatically correct, and self-contained.  
    - Avoid placeholders like '[link]' or '[data]'.  

    6. **Handling Missing or Ambiguous Data**:  
    - If no concrete question can be found, return no question found.

    7. **No Additional Context or Explanation**:  
    - Only output the question (with answer if available) or no question found.
    - Do **not** include notes, reasoning steps, or extra commentary.  

    **Critical Determinism Tips**:  
    - Always prioritize text over HTML unless HTML contains the main question.  
    - Always use attachments if they contain instructions.  
    - Always use explicit answers from the page if available; never infer or guess.  
    - Always append “No need of code” whenever the question can be answered without executing any computation, scraping, or parsing.
    
    **Goal**: When given the same input page content, your output should produce the same question at least 95% of the time.
    `
  );
  return lines.join("\n\n");
}

function buildClassificationPrompt(queryPrompt, fileList, lastError) {
  const lines = [];
  lines.push("QUESTION:\n" + queryPrompt);
  lines.push(
    "FILES AVAILABLE:\n" + (fileList.length ? fileList.join("\n") : "NONE")
  );
  if (lastError)
    lines.push(
      "Previous attempt failed with error: " + String(lastError).slice(0, 1000)
    );
  lines.push(
    `
    Task: Determine whether answering the given question requires executing code or programmatic computation. This includes numeric computation, aggregation, filtering, parsing data files, or any calculation that cannot be reliably performed by reasoning, observation, or direct lookup alone.
    
    Output ONLY one value: true or false.
    
    Rules:
    - Output true if the question requires programmatic computation, applying operations to a dataset, automatically parsing a file, or performing calculations that cannot be solved reliably by hand.
    - Scraping or extracting page content is NOT considered programmatic computation. All content is already provided in the context. Do NOT treat scraping as a reason to output true.
    - Output false if the question can be answered directly by reading text, listening to audio, interpreting an image, or looking up information in the provided context without performing any computation.
    - If the question involves a data file (CSV, JSON, audio-derived numbers, or similar), code is required ONLY if answering requires processing or transforming that file (sum, filter, count, parse, aggregate, or compute derived values).
    - Simple retrievals or lookups from a file (e.g., "what is the 3rd item in the file?") do NOT require code.
    - Any calculation that can be performed mentally or by inspection is NOT considered programmatic computation.
    - Do NOT infer, guess, or explain your answer. Output ONLY true or false, exactly in lowercase letters.
    - The output must be deterministic: for the same question and context, the answer must always be the same.
    
    Goal: Produce a single true or false answer that unambiguously reflects whether programmatic computation is required to answer the question.
    `
  );
  return lines.join("\n\n");
}

function buildSolvePrompt(queryPrompt) {
  const lines = [];
  lines.push("QUESTION:\n" + queryPrompt);
  lines.push(
    "Provide ONLY the final answer. Do not include explanations, reasoning, JSON, code, or any extra text. Output a single value exactly as required by the question."
  );
  return lines.join("\n\n");
}

function buildCodeGenPrompt(queryPrompt, fileNames, lastError) {
  const lines = [];
  lines.push("QUESTION:\n" + queryPrompt);
  if (lastError)
    lines.push("Previous failure: " + String(lastError).slice(0, 1000));
  lines.push(
    "FILES_AVAILABLE:\n" + (fileNames.length ? fileNames.join("\n") : "NONE")
  );
  lines.push(
    `
        Generate Node.js code only. The code must begin exactly with:
        module.exports = async function(files) {

        Requirements:
        - Return a plain JavaScript value or object directly from the function.
        - Do not print or log anything.
        - Do not output markdown, comments, explanations, reasoning, or any text outside valid JavaScript code.
        - Use only built-in modules (fs, path). Do not import any third-party libraries.
        - files is a map where keys are filenames and values are absolute file paths.
        - All computation must be deterministic and fully executed within this function.
        - The code must perform only the operations required to compute the answer.
        - Do not include example code, placeholders, or unused variables.
        `
  );
  return lines.join("\n\n");
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function uploadWithRetry(filePath, mimeType) {
  while (true) {
    try {
      console.log("[UPLOAD] Uploading File:", filePath);
      const res = await ai.files.upload({
        file: filePath,
        config: { mimeType },
      });
      console.log("[UPLOAD] Success:", filePath);
      return res;
    } catch (e) {
      console.log("[UPLOAD] Error:", e?.message || e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function runGeneratedCode(codeText, filesMap) {
  if (!codeText || /^\s*{/.test(codeText))
    throw new Error("codegen returned non-code");
  if (!codeText.trim().startsWith("module.exports"))
    throw new Error("generated code must start with 'module.exports'");
  const genPath = path.join(downloadsDir, "generated_task.js");
  fs.writeFileSync(genPath, codeText, "utf8");
  try {
    delete require.cache[require.resolve(genPath)];
  } catch {}
  const mod = require(genPath);
  const fn =
    typeof mod === "function"
      ? mod
      : mod && (mod.solve || mod.default || mod.module || mod.exports);
  if (typeof fn !== "function")
    throw new Error("generated module did not export a function");
  const result = await fn(filesMap);
  return result;
}

const isHtmlPage = (url) => {
  return url.startsWith("http") && !isFileUrl(url);
};

async function runLongTask(target) {
  let submissionUrl = null;
  try {
    const fullUrl = new URL(target);
    const baseUrl = fullUrl.origin;

    const promptFind = `
      Task: Extract the submission URL from the provided page contents.
  
      Requirements:
      - Respond with only the full absolute URL. Do NOT include JSON, markdown, or any extra text.
      - If the page provides a relative link (e.g., /submit), resolve it against the base URL ${baseUrl}.
      - Always return the FIRST submission URL found.
      - Deterministic output only.
    `;

    const respFind = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: createUserContent([target, promptFind]),
      config: { temperature: 0.1 },
    });

    submissionUrl = (respFind?.text || "").trim();
    console.log("[INIT] Submission URL is:", submissionUrl);
  } catch (err) {
    console.log(
      "[INIT] Failed to pre-extract submission URL:",
      err?.message || err
    );
  }

  const start = Date.now();
  const maxMs = 3 * 60 * 1000;

  // if (Date.now() - start > maxMs) {
  //   console.log(
  //     "[TIMEOUT] Global timeout exceeded (3 min). Sending placeholder answer..."
  //   );

  //   try {
  //     let postResp = await fetch(submissionUrl, {
  //       method: "POST",
  //       headers: { "content-type": "application/json" },
  //       body: JSON.stringify({
  //         email: process.env.EMAIL,
  //         secret: process.env.MY_SECRET,
  //         url: target,
  //         answer: "placeholderAnswer",
  //       }),
  //     });

  //     console.log("[TIMEOUT SUBMISSION] Status:", postResp.status);

  //     let raw = "";
  //     try {
  //       raw = await postResp.text();
  //       console.log("[TIMEOUT SUBMISSION] Raw text:", raw);
  //     } catch (err) {
  //       console.log(
  //         "[TIMEOUT SUBMISSION] Failed reading body:",
  //         err?.message || err
  //       );
  //     }

  //     let json = null;
  //     try {
  //       json = JSON.parse(raw);
  //     } catch (err) {
  //       console.log(
  //         "[TIMEOUT SUBMISSION] Non-JSON response:",
  //         err?.message || err
  //       );
  //     }

  //     if (json) {
  //       console.log("[TIMEOUT SUBMISSION] Response:", JSON.stringify(json));

  //       if (json.url) {
  //         console.log("[TIMEOUT CHAIN] Triggering next task:", json.url);

  //         fetch(`${process.env.SELF_URL}/task`, {
  //           method: "POST",
  //           headers: {
  //             "content-type": "application/json",
  //             "x-secret": process.env.MY_SECRET,
  //           },
  //           body: JSON.stringify({ url: json.url }),
  //         }).catch((err) => {
  //           console.log("[TIMEOUT CHAIN] Failed to trigger next task:", err);
  //         });
  //       }

  //       return;
  //     }

  //     console.log("[TIMEOUT] No valid next URL in response. Returning.");
  //     return;
  //   } catch (err) {
  //     console.log(
  //       "[TIMEOUT ERROR] Failed to auto-submit placeholder:",
  //       err?.message || err
  //     );
  //     return;
  //   }
  // }

  if (Date.now() - start > maxMs) {
    console.log(
      "[TIMEOUT] Global timeout exceeded. Sending placeholder answer..."
    );

    try {
      // --- NEW: extract submission URL safely ---
      let submissionUrlSafe = null;
      try {
        const fullUrl = new URL(target);
        const baseUrl = fullUrl.origin;

        const promptFind = `
          Task: Extract the submission URL from the provided page contents.
  
          Requirements:
          - Respond with only the full absolute URL.
          - If the page provides a relative link (e.g., /submit), resolve it against ${baseUrl}.
          - The output must be deterministic.
        `;

        const respFind = await ai.models.generateContent({
          model: "gemini-2.5-flash-lite",
          contents: createUserContent([promptFind]),
          config: { temperature: 0.1 },
        });

        submissionUrlSafe = (respFind?.text || "").trim();
        console.log("[TIMEOUT] Extracted submission URL:", submissionUrlSafe);
      } catch (e) {
        console.log(
          "[TIMEOUT] Failed to extract submission URL:",
          e?.message || e
        );
      }

      if (!submissionUrlSafe) {
        console.log(
          "[TIMEOUT] No submission URL available. Aborting timeout submit."
        );
        return;
      }

      let postResp = await fetch(submissionUrlSafe, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: process.env.EMAIL,
          secret: process.env.MY_SECRET,
          url: target,
          answer: "placeholderAnswer",
        }),
      });

      console.log("[TIMEOUT SUBMISSION] Status:", postResp.status);

      let raw = "";
      try {
        raw = await postResp.text();
        console.log("[TIMEOUT SUBMISSION] Raw text:", raw);
      } catch (err) {
        console.log(
          "[TIMEOUT SUBMISSION] Failed reading body:",
          err?.message || err
        );
      }

      let json = null;
      try {
        json = JSON.parse(raw);
      } catch (err) {
        console.log(
          "[TIMEOUT SUBMISSION] Non-JSON response:",
          err?.message || err
        );
      }

      if (json) {
        console.log("[TIMEOUT SUBMISSION] Response:", JSON.stringify(json));

        if (json.url) {
          console.log("[TIMEOUT CHAIN] Triggering next task:", json.url);

          fetch(`${process.env.SELF_URL}/task`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-secret": process.env.MY_SECRET,
            },
            body: JSON.stringify({ url: json.url }),
          }).catch((err) => {
            console.log("[TIMEOUT CHAIN] Failed to trigger next task:", err);
          });
        }

        return;
      }

      console.log("[TIMEOUT] No valid next URL in response. Returning.");
      return;
    } catch (err) {
      console.log(
        "[TIMEOUT ERROR] Failed to auto-submit placeholder:",
        err?.message || err
      );
      return;
    }
  }

  const checkTimeout = () => {
    if (Date.now() - start > maxMs)
      throw new Error("Global timeout exceeded (3 min)");
  };

  while (true) {
    checkTimeout();

    let lastError = null;
    let scraped = null;
    let candidateFiles = [];
    let saveMap = {};
    let uploadedParts = [];
    let queryPrompt = null;
    let answerFinal = null;

    try {
      // SCRAPE + DOWNLOAD + UPLOAD
      while (true) {
        checkTimeout();
        try {
          const { scraped: s, networkFiles } = await scrapePage(target);
          scraped = s;

          let extraPages = scraped.links.filter(isHtmlPage);

          for (const pageUrl of extraPages) {
            checkTimeout();
            try {
              console.log("[SCRAPE] Following HTML link:", pageUrl);

              const { scraped: subScraped, networkFiles: subFiles } =
                await scrapePage(pageUrl);

              scraped.text += "\n" + (subScraped.text || "");
              scraped.url += "\n" + (subScraped.url || "");
              scraped.html += "\n" + (subScraped.html || "");

              scraped.links.push(...subScraped.links);
              scraped.audio.push(...subScraped.audio);
              scraped.video.push(...subScraped.video);
              scraped.img.push(...subScraped.img);
              scraped.source.push(...subScraped.source);
              scraped.embed.push(...subScraped.embed);
              scraped.objectData.push(...subScraped.objectData);

              networkFiles.push(...subFiles);
            } catch (err) {
              console.log(
                "[SCRAPE] Failed linked page:",
                pageUrl,
                err?.message || err
              );
            }
          }

          candidateFiles = Array.from(
            new Set([
              ...scraped.links.filter(isFileUrl),
              ...scraped.audio,
              ...scraped.video,
              ...scraped.img,
              ...scraped.source,
              ...scraped.embed,
              ...scraped.objectData,
              ...networkFiles,
            ])
          );

          console.log("[PROCESS] Downloading files");
          for (const fu of candidateFiles) {
            checkTimeout();
            try {
              const filename =
                path.basename(new URL(fu).pathname) ||
                `file-${Math.random().toString(36).slice(2, 8)}`;
              const mime = mimeFromName(filename);
              if (mime === "application/octet-stream") {
                console.log("[SKIP] Unsupported file type:", filename, mime);
                continue;
              }
              const savePath = await downloadToDisk(fu, filename);
              saveMap[filename] = savePath;
            } catch (err) {
              lastError = err;
              console.log("[ERROR] File download failed", err?.message || err);
              throw err;
            }
          }

          console.log("[PROCESS] Uploading files for model access");
          for (const filename of Object.keys(saveMap)) {
            checkTimeout();
            try {
              const mime = mimeFromName(filename);
              const uploaded = await uploadWithRetry(saveMap[filename], mime);
              uploadedParts.push(
                createPartFromUri(uploaded.uri, uploaded.mimeType)
              );
            } catch (err) {
              lastError = err;
              console.log("[ERROR] File upload failed", err?.message || err);
              throw err;
            }
          }

          break;
        } catch (err) {
          lastError = err;
          console.log(
            "[RETRY] Scrape/download/upload failed, retrying...",
            err?.message || err
          );
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      // PHASE A: Extract question
      while (!queryPrompt) {
        checkTimeout();
        try {
          const promptA = buildQuestionPrompt(
            scraped,
            Object.keys(saveMap),
            lastError && String(lastError)
          );
          const respA = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: createUserContent([...uploadedParts, promptA]),
            config: {
              temperature: 0.1,
            },
          });
          queryPrompt = respA?.text || "";
          console.log("[PHASE A] question extracted:", queryPrompt);
        } catch (err) {
          lastError = err;
          console.log("[PHASE A] failed, retrying...", err?.message || err);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      // PHASE B: Decide if code is needed
      let needsCode = false;
      while (true) {
        checkTimeout();
        try {
          const promptB = buildClassificationPrompt(
            queryPrompt,
            Object.keys(saveMap),
            lastError && String(lastError)
          );
          const respB = await ai.models.generateContent({
            model: "gemini-2.5-flash-lite",
            contents: createUserContent([...uploadedParts, promptB]),
            config: {
              temperature: 0.1,
            },
          });
          const txtB = respB?.text || "";
          needsCode = txtB.toLowerCase() === "true";
          console.log("[PHASE B] needs_code =", needsCode);
          break;
        } catch (err) {
          lastError = err;
          console.log("[PHASE B] failed, retrying...", err?.message || err);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      if (!needsCode) {
        // PHASE C: Solve directly
        while (true) {
          checkTimeout();
          try {
            const promptC = buildSolvePrompt(queryPrompt);
            const respC = await ai.models.generateContent({
              model: "gemini-2.5-flash",
              contents: createUserContent([...uploadedParts, promptC]),
              config: {
                temperature: 0.1,
              },
            });
            console.log("[PHASE C] solved:", respC?.text || "");
            answerFinal = respC?.text || "";
            break;
          } catch (err) {
            lastError = err;
            console.log("[PHASE C] failed, retrying...", err?.message || err);
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      } else {
        // PHASE C: Generate and execute code
        let codeText = null;
        while (!codeText) {
          checkTimeout();
          try {
            const promptCode = buildCodeGenPrompt(
              queryPrompt,
              Object.keys(saveMap),
              lastError && String(lastError)
            );
            const respCode = await ai.models.generateContent({
              model: "gemini-2.5-flash",
              contents: createUserContent([...uploadedParts, promptCode]),
              config: {
                temperature: 0.1,
              },
            });
            let raw = respCode?.text || "";
            if (raw.startsWith("```"))
              raw = raw
                .replace(/^```(?:\w*)\s*/, "")
                .replace(/```$/, "")
                .trim();
            if (!raw.startsWith("module.exports"))
              throw new Error("codegen returned unexpected output");
            codeText = raw;
          } catch (err) {
            lastError = err;
            console.log("[CODEGEN] failed, retrying...", err?.message || err);
            await new Promise((r) => setTimeout(r, 1000));
          }
        }

        let execResult = null;
        while (!execResult) {
          checkTimeout();
          try {
            execResult = await runGeneratedCode(codeText, saveMap);
            console.log("[EXEC RESULT]", execResult);
            answerFinal = execResult;
          } catch (err) {
            lastError = err;
            console.log("[EXEC ERROR] retrying...", err?.message || err);
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }

      if (answerFinal) console.log("[FINAL ANSWER]", answerFinal);
      let submissionUrl = "";
      while (!submissionUrl) {
        checkTimeout();
        try {
          const fullUrl = new URL(target);
          const baseUrl = `${fullUrl.origin}`;
          console.log(baseUrl);

          const promptFind = `
          Task: Extract the submission URL from the provided page contents.

          Requirements:
          - Respond with only the full absolute URL. Do NOT include JSON, markdown, or any extra text.
          - If the page provides a relative link (e.g., /submit), resolve it against the base URL ${baseUrl} to produce the absolute URL.
          - Always prioritize the first valid submission link found in the page content.
          - Do not infer or guess URLs; extract only what is explicitly present in the page content.
          - The output must be deterministic: for the same page content and base URL, the output must always be exactly the same.
          
          Output: Only the full absolute URL as plain text.
    `;

          const respFind = await ai.models.generateContent({
            model: "gemini-2.5-flash-lite",
            contents: createUserContent([
              scraped.text,
              scraped.html,
              scraped.links.join("\n"),
              promptFind,
            ]),
            config: {
              temperature: 0.1,
            },
          });
          submissionUrl = (respFind?.text || "").trim();
          console.log("[FIND SUBMISSION URL] found:", submissionUrl);
        } catch (err) {
          console.log(
            "[FIND SUBMISSION URL] failed, retrying...",
            err?.message || err
          );
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      let postResp = await fetch(submissionUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: process.env.EMAIL,
          secret: process.env.MY_SECRET,
          url: target,
          answer: answerFinal,
        }),
      });

      console.log("[SUBMISSION] Status:", postResp.status);
      let raw = "";
      try {
        raw = await postResp.text();
        console.log("[SUBMISSION] Raw text:", raw);
      } catch (err) {
        console.log("[SUBMISSION] Failed reading body:", err?.message || err);
      }

      let json = null;
      try {
        json = JSON.parse(raw);
      } catch (err) {
        console.log("[SUBMISSION] Non-JSON response:", err?.message || err);
      }

      if (json && json.correct === true) {
        console.log("[SUBMISSION] Response:", JSON.stringify(json));
        if (json.url) {
          console.log("[CHAIN] Triggering next task:", json.url);

          fetch(`${process.env.SELF_URL}/task`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-secret": process.env.MY_SECRET,
            },
            body: JSON.stringify({ url: json.url }),
          }).catch((err) => {
            console.log("[CHAIN] Failed to trigger next task:", err);
          });

          return; // IMPORTANT: stops current task
        }

        console.log("[CHAIN] Completed all tasks.");
        return;
      }
    } catch (err) {
      lastError = err;
      console.log("[ERROR] Fatal:", err?.message || err);
    }
  }
}

app.post("/task", async (req, res) => {
  console.log("[START] Incoming request");

  let body;
  try {
    body = req.body;
  } catch (err) {
    return res.status(400).json({ error: "invalid JSON" });
  }

  const providedSecret =
    req.header("x-secret") || body.secret || req.query.secret;

  if (!providedSecret) {
    console.log("[AUTH] Missing secret");
    return res.status(403).json({ error: "missing secret" });
  }

  if (providedSecret !== process.env.MY_SECRET) {
    console.log("[AUTH] Invalid secret");
    return res.status(403).json({ error: "invalid secret" });
  }

  const target = body.url || req.query.url;
  if (!target) {
    console.log("[REQUEST] Missing URL");
    return res.status(400).json({ error: "missing url" });
  }

  console.log("[START] Accepted. URL:", target);
  res.status(200).json({ status: "accepted" });

  setImmediate(() => {
    runLongTask(target).catch((err) => console.log("[BACKGROUND ERROR]", err));
  });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running at http://localhost:${process.env.PORT || 3000}`);
});
