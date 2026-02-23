import { options } from '@/core/options';
import { Tweet } from '@/types';
import { formatDateTime, parseTwitterDateTime } from '@/utils/common';
import {
  extractQuotedTweet,
  extractRetweetedTweet,
  extractTweetFullText,
  extractTweetMedia,
  extractTweetMediaTags,
  formatTwitterImage,
  getMediaOriginalUrl,
  getTweetURL,
} from '@/utils/api';

export interface TweetViewPayload {
  id: string;
  created_at: string;
  full_text: string;
  media: Array<{
    type: string;
    url: string;
    thumbnail: string;
    original: string;
    ext_alt_text?: string;
  }>;
  screen_name?: string;
  name?: string;
  profile_image_url?: string;
  user_id?: string;
  in_reply_to?: string;
  retweeted_status?: string;
  quoted_status?: string;
  media_tags: ReturnType<typeof extractTweetMediaTags>;
  favorite_count?: number;
  retweet_count?: number;
  bookmark_count?: number;
  quote_count?: number;
  reply_count?: number;
  views_count: number | null;
  favorited?: boolean;
  retweeted?: boolean;
  bookmarked?: boolean;
  url: string;
}

export function buildTweetViewPayload(tweet: Tweet): TweetViewPayload {
  return {
    id: tweet.rest_id,
    created_at: formatDateTime(
      parseTwitterDateTime(tweet.legacy?.created_at),
      options.get('dateTimeFormat'),
    ),
    full_text: extractTweetFullText(tweet),
    media: extractTweetMedia(tweet).map((media) => ({
      type: media.type,
      url: media.url,
      thumbnail: formatTwitterImage(media.media_url_https, 'thumb'),
      original: getMediaOriginalUrl(media),
      ext_alt_text: media.ext_alt_text,
    })),
    screen_name: tweet.core?.user_results?.result?.core?.screen_name,
    name: tweet.core?.user_results?.result?.core?.name,
    profile_image_url: tweet.core?.user_results?.result?.avatar?.image_url,
    user_id: tweet.core?.user_results?.result?.rest_id,
    in_reply_to: tweet.legacy?.in_reply_to_status_id_str,
    retweeted_status: extractRetweetedTweet(tweet)?.rest_id,
    quoted_status: extractQuotedTweet(tweet)?.rest_id,
    media_tags: extractTweetMediaTags(tweet),
    favorite_count: tweet.legacy?.favorite_count,
    retweet_count: tweet.legacy?.retweet_count,
    bookmark_count: tweet.legacy?.bookmark_count,
    quote_count: tweet.legacy?.quote_count,
    reply_count: tweet.legacy?.reply_count,
    views_count: typeof tweet.views?.count === 'undefined' ? null : +tweet.views.count,
    favorited: tweet.legacy?.favorited,
    retweeted: tweet.legacy?.retweeted,
    bookmarked: tweet.legacy?.bookmarked,
    url: getTweetURL(tweet),
  };
}
