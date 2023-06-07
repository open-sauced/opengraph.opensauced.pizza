import { ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs/promises";
import { GithubService } from "../../github/github.service";
import { S3FileStorageService } from "../../s3-file-storage/s3-file-storage.service";

import tailwindConfig from "../templates/tailwind.config";
import { firstValueFrom } from "rxjs";

import { RequiresUpdateMeta } from "../user-card/user-card.service";
import { DbInsight } from "../../github/entities/db-insight.entity";
import insightCardTemplate from "../templates/insight-card.template";

/*
 * interface HighlightCardData {
 *   title: string;
 *   body: string;
 *   reactions: number;
 *   avatarUrl: string;
 *   repo: Repository;
 *   langTotal: number;
 *   langs: (Language & {
 *     size: number;
 *   })[];
 *   updated_at: Date;
 *   url: string;
 * }
 */

interface InsightCardData {
  pageName: string;
  repos: { repoName: string; avatarUrl: string }[];
  contributors: string[];
  updated_at: Date;
}

@Injectable()
export class InsightCardService {
  private readonly logger = new Logger(this.constructor.name);

  constructor (
    private readonly httpService: HttpService,
    private readonly githubService: GithubService,
    private readonly s3FileStorageService: S3FileStorageService,
  ) {}

  private async getInsightData (insightId: number): Promise<InsightCardData> {
    /*
     * const highlightReq = await firstValueFrom(
     *   this.httpService.get<DbUserHighlight>(`https://api.opensauced.pizza/v1/user/highlights/${highlightId}`)
     * );
     * const { login, title, highlight: body, updated_at, url } = highlightReq.data;
     */

    const insightPageReq = await firstValueFrom(
      this.httpService.get<DbInsight>(`https://api.opensauced.pizza/v1/insights/${insightId}`),
    );

    const { repos, name, updated_at } = insightPageReq.data;

    const repoIdsQuery = repos.map(repo => repo.repo_id).join(",");

    const contributorsReq = await firstValueFrom(
      this.httpService.get<{ author_login: string }[]>(
        `https://api.opensauced.pizza/v1/contributors/search?repoIds=${repoIdsQuery}`,
      ),
    );
    const contributors = contributorsReq.data.map(contributor => contributor.author_login);

    const repositories = repos.map(repo => {
      const [owner, repoName] = repo.full_name.split("/");

      return {
        repoName,
        avatarUrl: `https://github.com/${owner}.png&size=50`,
      };
    });

    // const [owner, repoName] = url.replace("https://github.com/", "").split("/");

    /*
     * const user = await this.githubService.getUser(login);
     * const repo = await this.githubService.getRepo(owner, repoName);
     */

    /*
     * const langList = repo.languages?.edges?.flatMap(edge => {
     *   if (edge) {
     *     return {
     *       ...edge.node,
     *       size: edge.size,
     *     };
     *   }
     * }) as (Language & { size: number })[];
     */

    return {
      pageName: name,
      repos: repositories,
      contributors,
      updated_at: new Date(updated_at),
    };
  }

  // public only to be used in local scripts. Not for controller direct use.
  async generateCardBuffer (insightId: number, insightData?: InsightCardData) {
    const { html } = await import("satori-html");
    const satori = (await import("satori")).default;

    const { pageName, repos, contributors } = insightData ? insightData : await this.getInsightData(insightId);

    const template = html(insightCardTemplate(pageName, contributors, repos));

    const interArrayBuffer = await fs.readFile("node_modules/@fontsource/inter/files/inter-all-400-normal.woff");

    const svg = await satori(template, {
      width: 1200,
      height: 627,
      fonts: [
        {
          name: "Inter",
          data: interArrayBuffer,
          weight: 400,
          style: "normal",
        },
      ],
      tailwindConfig,
    });

    const resvg = new Resvg(svg, { background: "rgba(238, 235, 230, .9)" });

    const pngData = resvg.render();

    return { png: pngData.asPng(), svg };
  }

  async checkRequiresUpdate (id: number): Promise<RequiresUpdateMeta> {
    const hash = `insights/${String(id)}.png`;
    const fileUrl = `${this.s3FileStorageService.getCdnEndpoint()}${hash}`;
    const hasFile = await this.s3FileStorageService.fileExists(hash);

    const returnVal: RequiresUpdateMeta = {
      fileUrl,
      hasFile,
      needsUpdate: true,
      lastModified: null,
    };

    if (hasFile) {
      const lastModified = await this.s3FileStorageService.getFileLastModified(hash);

      returnVal.lastModified = lastModified;

      const { updated_at } = await this.getInsightData(id);

      /*
       * const metadata = await this.s3FileStorageService.getFileMeta(hash);
       * const savedReactions = metadata?.["reactions-count"] ?? "0";
       */

      if (lastModified && lastModified > updated_at) {
        this.logger.debug(
          `Highlight ${id} exists in S3 with lastModified: ${lastModified.toISOString()} newer than updated_at: ${updated_at.toISOString()}, and reaction count is the same, redirecting to ${fileUrl}`,
        );
        returnVal.needsUpdate = false;
      }
    }

    return returnVal;
  }

  async getgetInsightCard (id: number): Promise<string> {
    const { remaining } = await this.githubService.rateLimit();

    if (remaining < 1000) {
      throw new ForbiddenException("Rate limit exceeded");
    }

    const insightData = await this.getInsightData(id);

    try {
      const hash = `insights/${String(id)}.png`;
      const fileUrl = `${this.s3FileStorageService.getCdnEndpoint()}${hash}`;

      const { png } = await this.generateCardBuffer(id, insightData);

      await this.s3FileStorageService.uploadFile(png, hash, "image/png");

      this.logger.debug(`Insight ${id} did not exist in S3, generated image and uploaded to S3, redirecting`);

      return fileUrl;
    } catch (e) {
      this.logger.error(`Error generating insight card for ${id}`, e);

      throw (new NotFoundException);
    }
  }
}