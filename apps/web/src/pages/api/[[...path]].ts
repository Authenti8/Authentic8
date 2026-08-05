import { getServerlessHandler } from "@authenti8/api/serverless";
import type { NextApiRequest, NextApiResponse } from "next";

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
  maxDuration: 60,
};

export default async function handler(request: NextApiRequest, response: NextApiResponse) {
  if (request.url?.startsWith("/v1/")) request.url = `/api${request.url}`;
  const nestHandler = await getServerlessHandler();
  await new Promise<void>((resolve, reject) => {
    response.once("finish", resolve);
    response.once("close", resolve);
    try {
      nestHandler(request, response);
    } catch (error) {
      reject(error);
    }
  });
}
