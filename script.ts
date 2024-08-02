#!/usr/bin/env -S deno run -A --allow-env
import CryptoJS from "npm:crypto-js";
import { decode as base64Decode,
  encode as base64Encode,
} from "https://deno.land/std@0.166.0/encoding/base64.ts"; import {
  DOMParser,
  Element,
  HTMLDocument,
  Node,
} from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

const host = new URL(Deno.args[0]).host;
const ytdlpPath = "/home/ubuntu/.local/bin/yt-dlp";

//thanks to luma,guy on discord
function decrypt(jsonStr: string, password: string) {
  const payloadParsed = JSON.parse(jsonStr);
  const keyParts = password.split("\\x");
  let newKey = "";
  const items = new TextDecoder()
    .decode(
      base64Decode(
        payloadParsed.m
          .split("")
          .reduce(
            (accumulator: string, currentValue: string) =>
              currentValue + accumulator,
            ""
          )
      )
    )
    .split("|");

  for (const item of items) {
    newKey += "\\x" + keyParts[parseInt(item) + 1];
  }

  return JSON.parse(
    CryptoJS.AES.decrypt(jsonStr, newKey, {
      format: {
        parse: function (jsonStr: string) {
          const j = JSON.parse(jsonStr);
          const cipherParams = CryptoJS.lib.CipherParams.create({
            ciphertext: CryptoJS.enc.Base64.parse(j.ct),
          });

          if (j.iv) {
            cipherParams.iv = CryptoJS.enc.Hex.parse(j.iv);
          }
          if (j.s) {
            cipherParams.salt = CryptoJS.enc.Hex.parse(j.s);
          }

          return cipherParams;
        },
      },
    }).toString(CryptoJS.enc.Utf8)
  );
}

async function getVideoHash(episodeId: string): Promise<string> {
  const res = await fetch(`https://${host}/wp-admin/admin-ajax.php`, {
    method: "POST",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/111.0",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body: `action=doo_player_ajax&post=${episodeId}&nume=1&type=tv`,
    redirect: "follow",
  });

  const data = await res.json();
  const embedUrl = decrypt(data.embed_url, data.key);
  const hash = embedUrl.split("/").slice(-1)[0];

  return hash;
}

async function getVideoSource(hashId: string): Promise<string> {
  const res = await fetch(
    `https://jeniusplay.com/player/index.php?data=${hashId}&do=getVideo`,
    {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/111.0",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Origin: "https://jeniusplay.com",
      },
      body: `hash=${hashId}&r=https://${host}`,
    }
  );
  const data = await res.json();
  return data.videoSource;
}

async function getSubSource(hashId: string): Promise<string[]> {
  const res = await fetch(
    `https://jeniusplay.com/player/index.php?data=${hashId}`,
    {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/111.0",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Origin: "https://jeniusplay.com",
      },
      body: `hash=${hashId}&r=https://${host}`,
    }
  );
  const html: string = await res.text();
  const document: HTMLDocument = new DOMParser().parseFromString(
    html,
    "text/html"
  ) as HTMLDocument;
  const scriptTagElement: Node[] = [
    ...document.querySelectorAll("script"),
  ] as Node[];

  const scriptTag = scriptTagElement.find((item) =>
    item.textContent?.includes("playerjsSubtitle")
  )?.textContent as string;

  const cleanLink = scriptTag
    .split(";")[0]
    .split("=")[1]
    .split(",")
    .map((item) =>
      item
        .replace(/\"/g, "")
        .replace(/\[.+\]/g, "")
        .trim()
    );

  return cleanLink;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getHTML(url: string): Promise<HTMLDocument> {
  const res = await fetch(url);
  const html: string = await res.text();

  const document: HTMLDocument = new DOMParser().parseFromString(
    html,
    "text/html"
  ) as HTMLDocument;

  return document;
}

async function downloadMovie(title: string, document: HTMLDocument) {
  const episodeId = document
    .querySelector(".dooplay_player_option")
    ?.getAttribute("data-post") as string;

  const hashId: string = await getVideoHash(episodeId);
  const videoSource: string = await getVideoSource(hashId);
  const subSource: string[] = await getSubSource(hashId);
  await Deno.mkdir(`/media/ubuntu/movies/${title}`, { recursive: true });
  const proc = await new Deno.Command(ytdlpPath, {
    args: [videoSource, `-P /media/ubuntu/movies/${title}`],
  }).spawn();

  const output = await proc.output();
  if (output.success) {
    downloadSubtitle(subSource, `/media/ubuntu/movies/${title}`);
  }
}

async function downloadTvSeries(title: string, episodes: Element[]) {
  for (const episode of episodes) {
    const episodePage: HTMLDocument | null | undefined = await getHTML(
      episode.getAttribute("href") || ""
    );

    const season = episode
      .closest(".se-c")
      ?.querySelector(".se-t")?.textContent;
    const episodeTitle = episode.textContent;

    const episodeId: string =
      episodePage
        ?.querySelector(".dooplay_player_option")
        ?.getAttribute("data-post") || "";

    const hashId: string = await getVideoHash(episodeId);
    const videoSource: string = await getVideoSource(hashId);
    const subSource: string[] = await getSubSource(hashId);

    await Deno.mkdir(`/media/ubuntu/series/${title}`, {
      recursive: true,
    });

    const proc = new Deno.Command(ytdlpPath, {
      args: [
        videoSource,
        `-P /media/ubuntu/series/${title}/season${season}/${episodeTitle}`,
      ],
    }).spawn();

    const output = await proc.output();
    if (output.success) {
      downloadSubtitle(
        subSource,
        `/media/ubuntu/series/${title}/season${season}/${episodeTitle}`
      );
    }
    //await Deno.mkdir(episodeTitle, { recursive: true });
  }
}

async function downloadSubtitle(subSource: string[], path: string) {
  for (const [index, sub] of subSource.entries()) {
    const response = await fetch(sub);
    const data = await response.text();

    await Deno.writeTextFile(`${path}/sub${index}.srt`, data);
  }
}

async function download(url: string) {
  const document = await getHTML(url);
  const title = document.querySelector(".data h1")?.textContent || "";

  const episodesElement = document.querySelectorAll(
    ".episodiotitle a"
  ) as Iterable<Element>;
  const episodes: Element[] = [...episodesElement];

  if (!episodes.length) downloadMovie(title, document);

  downloadTvSeries(title, episodes);
}

async function main() {
  const documentGenre = await getHTML(
    "https://tv.idlixofficial.net/genre/science-fiction/"
  );
  const items: Element[] = documentGenre.querySelectorAll("article.item");

  for (const item of items) {
    console.log(item.querySelector(".data h3 a")?.textContent);
  }
}

async function test() {
  for (const i in [...Array.from({ length: 5 })]) {
    const proc = new Deno.Command("echo", {
      args: [i],
    }).spawn();

    const output = await proc.output();
    console.log(output);

    console.log("test");
  }
}

download(Deno.args[0]);
//test();
//main();
