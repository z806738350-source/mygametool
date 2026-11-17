import { DOMParser, type Element } from "@xmldom/xmldom";
import { PLUGIN_ICON_MAX_DIMENSION } from "../shared/plugin-icons.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const elements = new Set(
  "svg g path circle ellipse rect line polyline polygon defs clipPath mask linearGradient radialGradient stop symbol use title desc".split(
    " ",
  ),
);
const attributes = new Set(
  "id viewBox width height x y x1 y1 x2 y2 cx cy r rx ry fx fy fr d points transform opacity fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset clip-path clip-rule clipPathUnits mask maskUnits maskContentUnits gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity preserveAspectRatio vector-effect role aria-hidden aria-label".split(
    " ",
  ),
);
const paintAttributes = new Set(["fill", "stroke", "stop-color"]);
const localReference = /^url\(#[\w:.-]+\)$/;
const color =
  /^(?:[a-z]+|#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-/]+\))$/i;
const vectorElements = new Set("path circle ellipse rect line polyline polygon text".split(" "));
const textAttributes = new Set("dx dy font-family font-size font-weight letter-spacing text-anchor dominant-baseline".split(" "));
export const GENERATED_SVG_MAX_BYTES = 2 * 1024 * 1024;

/** Accept only self-contained, static vector artwork; reject unsupported input. */
export function validatePluginSvg(bytes: Buffer): void {
  validateStaticSvg(bytes, false);
}

export function validateGeneratedSvg(bytes: Buffer): { width: number; height: number } {
  if (bytes.length > GENERATED_SVG_MAX_BYTES) throw new Error("Generated SVG exceeds the local 2 MiB vector validation limit");
  return validateStaticSvg(bytes, true);
}

function validateStaticSvg(bytes: Buffer, generated: boolean): { width: number; height: number } {
  const dimensionLimit = generated ? 16384 : PLUGIN_ICON_MAX_DIMENSION;
  const invalid = (): never => {
    throw new Error(
      "Use a static SVG with a viewBox or dimensions, shapes, and presentation attributes; scripts, styles, and external resources are not supported",
    );
  };
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid();
  }
  if (!source.trimStart().startsWith("<") || /<!DOCTYPE|<!ENTITY/i.test(source))
    invalid();
  const document = new DOMParser({
    onError: invalid,
  }).parseFromString(source, "application/xml");
  const root = document.documentElement;
  if (
    !root ||
    root.tagName !== "svg" ||
    root.namespaceURI !== SVG_NAMESPACE ||
    document.doctype
  )
    return invalid();
  for (let node = document.firstChild; node; node = node.nextSibling) {
    if (
      node === root ||
      node.nodeType === 8 ||
      (node.nodeType === 3 && !node.nodeValue?.trim())
    )
      continue;
    if (node.nodeType === 7 && node.nodeName === "xml" && node.nextSibling)
      continue;
    invalid();
  }
  const viewBox = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (!generated || root.hasAttribute("viewBox")) {
    if (viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value)))
      invalid();
    for (const value of viewBox.slice(2)) {
      if (value <= 0 || value > dimensionLimit)
        throw new Error(`SVG viewBox must be at most ${dimensionLimit} × ${dimensionLimit} units`);
    }
  } else if (!root.hasAttribute("width") || !root.hasAttribute("height")) invalid();
  for (const name of ["width", "height"]) {
    if (!root.hasAttribute(name)) continue;
    const value = root.getAttribute(name) ?? "";
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/.test(value)) invalid();
    const size = Number.parseFloat(value);
    if (size <= 0 || size > dimensionLimit)
      throw new Error(`SVG dimensions must be at most ${dimensionLimit} × ${dimensionLimit} pixels`);
  }
  const pending: Element[] = [root];
  let count = 0;
  let hasVector = false;
  while (pending.length) {
    const element = pending.pop()!;
    const isText = generated && (element.tagName === "text" || element.tagName === "tspan");
    if (vectorElements.has(element.tagName)) hasVector = true;
    if (
      ++count > (generated ? 10000 : 2048) ||
      element.namespaceURI !== SVG_NAMESPACE ||
      (!elements.has(element.tagName) && !isText)
    )
      invalid();
    for (let index = 0; index < element.attributes.length; index++) {
      const attribute = element.attributes.item(index)!;
      const { name, value } = attribute;
      if (name === "xmlns" && value === SVG_NAMESPACE) continue;
      if (name === "xmlns:xlink" && value === XLINK_NAMESPACE) continue;
      if (
        name === "href" ||
        (name === "xlink:href" && attribute.namespaceURI === XLINK_NAMESPACE)
      ) {
        if (!/^#[\w:.-]+$/.test(value)) invalid();
        continue;
      }
      if (attribute.namespaceURI || (!attributes.has(name) && !(generated && textAttributes.has(name)))) invalid();
      if (generated && textAttributes.has(name) && !/^[\p{L}\p{N}\s.,'"%+-]+$/u.test(value)) invalid();
      if (
        paintAttributes.has(name) &&
        !color.test(value) &&
        !localReference.test(value)
      )
        invalid();
      if (
        (name === "clip-path" || name === "mask") &&
        value !== "none" &&
        !localReference.test(value)
      )
        invalid();
    }
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) pending.push(child as Element);
      else if (child.nodeType === 8) continue;
      else if (
        (child.nodeType === 3 || child.nodeType === 4) &&
        (isText || element.tagName === "title" ||
          element.tagName === "desc" ||
          !child.nodeValue?.trim())
      )
        continue;
      else invalid();
    }
  }
  if (generated && !hasVector) invalid();
  const width = Number.parseFloat(root.getAttribute("width") ?? "");
  const height = Number.parseFloat(root.getAttribute("height") ?? "");
  const ratio = viewBox[2]! / viewBox[3]!;
  const w = width || (height ? height * ratio : viewBox[2]!);
  const h = height || (width ? width / ratio : viewBox[3]!);
  if (generated && (w > dimensionLimit || h > dimensionLimit)) invalid();
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}
