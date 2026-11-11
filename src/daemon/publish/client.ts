import type { CommunityGame, ProjectState, PublishResult } from "../../shared/contracts.js";
import type { CommunityGameStats, CommunityGamesQuery, CommunityProfile } from "../../shared/publish-v1.js";

export interface RemotePublisherOptions { apiUrl: string; fetch?: typeof fetch; visitorTokenFile?: string }
export class RemotePublishError extends Error {
  constructor(message: string, readonly statusCode = 502, readonly code?: string) { super(message); }
}
export const LOCAL_PUBLISH_UNAVAILABLE = "Community and remote publishing are not provided by the local secure edition.";
const unavailable = () => new RemotePublishError(LOCAL_PUBLISH_UNAVAILABLE, 410, "local_edition_unavailable");

/** Historical API compatibility only; never stores credentials, reads visitor files, or creates a transport. */
export class RemotePublisher {
  constructor(_options?: RemotePublisherOptions) {}
  async publish(_project: ProjectState, _artifact: Buffer, _accessToken: string, _metadata: { title: string; description?: string }): Promise<PublishResult> { throw unavailable(); }
  async community(_metrics = false, _accessToken?: string, _options: CommunityGamesQuery = {}): Promise<CommunityGame[]> { throw unavailable(); }
  async communityGame(_gameId: string, _metrics = false, _accessToken?: string): Promise<CommunityGame> { throw unavailable(); }
  async communityGameCover(_gameId: string, _deploymentId: string, _accessToken?: string): Promise<Buffer> { throw unavailable(); }
  async profile(_authorId: string, _accessToken?: string): Promise<CommunityProfile> { throw unavailable(); }
  async myGames(_accessToken: string): Promise<CommunityProfile> { throw unavailable(); }
  async updateCommunityGame(_gameId: string, _accessToken: string, _metadata: { title: string; description?: string }): Promise<void> { throw unavailable(); }
  async setLike(_gameId: string, _accessToken: string | undefined, _liked: boolean): Promise<CommunityGameStats> { throw unavailable(); }
  async unpublish(_gameId: string, _accessToken: string): Promise<void> { throw unavailable(); }
}
