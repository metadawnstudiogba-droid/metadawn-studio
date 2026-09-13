import kkidc from "../providers/kkidc.json";
import ark from "../providers/volcengine-ark.json";
import { validateProviderTemplate } from "./provider-template";

export const BUILTIN_TEMPLATES = [kkidc, ark].map(validateProviderTemplate);
export const DEFAULT_TEMPLATE = BUILTIN_TEMPLATES[0];
