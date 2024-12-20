import { Injectable, Logger } from '@nestjs/common';
import { Neo4jService } from 'src/neo4j/neo4j.service';
import { ArticlesCitationsFilterDto } from '../dto/articles-citations-filter.dto';
import { ElasticsearchService } from '@nestjs/elasticsearch';

@Injectable()
export class ArticlesCitationsService {
  private readonly logger = new Logger(ArticlesCitationsService.name);

  constructor(
    private readonly neo4jService: Neo4jService,
    private readonly elasticsearchService: ElasticsearchService,
  ) {}

  public async getCitedByArticles(filter: ArticlesCitationsFilterDto) {
    const { articleId, searchTerm, skip, limit } = filter;

    this.logger.log(`Fetching articles cited by article: ${articleId}`);

    // Helper function to construct the search condition for articles
    const getSearchCondition = (alias: string, nameAlias: string) => {
      if (!searchTerm) return '';
      const lowerSearch = `toLower($searchTerm)`;
      return `
      WHERE toLower(${nameAlias}) CONTAINS ${lowerSearch}
      OR toLower(${alias}.number) CONTAINS ${lowerSearch}
      OR toLower(${alias}.text) CONTAINS ${lowerSearch}
    `;
    };

    // Helper to fetch count query for cited articles
    const getCountQuery = () => `
    MATCH (a:Article)-[:CITES]->(b:Article {number: $articleId})
    OPTIONAL MATCH (a)-[:IS_NAMED]->(n:Name)
    WITH a, n  
    ${getSearchCondition('a', 'n.short')}
    RETURN count(a) AS totalCount
  `;

    // Helper to fetch paginated cited articles query
    const getArticlesQuery = () => `
    MATCH (a:Article)-[:CITES]->(b:Article {number: $articleId})
    OPTIONAL MATCH (a)-[:IS_NAMED]->(n:Name)
    WITH a, n 
    ${getSearchCondition('a', 'n.short')} 
    RETURN DISTINCT a, n.short AS name, elementId(a) AS elementId
    ORDER BY a.citing_cases DESC
    SKIP toInteger($skip) LIMIT toInteger($limit)
  `;

    try {
      // Execute the count and paginated queries concurrently using neo4jService
      const [countResult, articlesResult] = await Promise.all([
        this.neo4jService.runQuery(getCountQuery(), { articleId, searchTerm }),
        this.neo4jService.runQuery(getArticlesQuery(), {
          articleId,
          searchTerm,
          skip,
          limit,
        }),
      ]);

      // Extract the total count of articles
      const totalCount = countResult[0]?.get('totalCount').low || 0;

      // Process the articles
      const articles = articlesResult.map((record) => {
        const article = record.get('a').properties;
        const citedArticleId = record.get('elementId');
        const name = record.get('name');
        return { ...article, id: citedArticleId, name };
      });
      const elasticSearchResults = await Promise.all(
        articles.map(async (articleData) => {
          const query = {
            index: 'articles',
            body: {
              query: {
                match: {
                  number: articleData.number,
                },
              },
            },
          };
          const result = await this.elasticsearchService.search(query);
          return result.hits.hits.map((hit) => hit._source);
        }),
      );

      const flattenedResults = elasticSearchResults.flat().sort((a, b) => {
        const aHasName = a['name'] ? 1 : 0;
        const bHasName = b['name'] ? 1 : 0;
        return bHasName - aHasName;
      });
      return { articles: flattenedResults, total: totalCount };
    } catch (error) {
      this.logger.error(
        `Error fetching articles cited by article ${articleId}: ${error.message}`,
      );
      throw error;
    }
  }

  public async getCitedByArticlesCount(articleId: string) {
    this.logger.log(
      `Fetching count of articles cited by article: ${articleId}`,
    );

    let query = `MATCH (a:Article)-[:CITES]->(b:Article{number: $articleId}) `;
    query += `OPTIONAL MATCH (a:Article)-[:IS_NAMED]->(n:Name) `;
    query += `RETURN COUNT(a) AS count`;

    try {
      const result = await this.neo4jService.runQuery(query, { articleId });
      return result[0].get('count').low;
    } catch (error) {
      this.logger.error(
        `Error fetching count of articles cited by article ${articleId}: ${error.message}`,
      );
      throw error;
    }
  }

  public async getArticleCitingOtherArticles(
    filter: ArticlesCitationsFilterDto,
  ) {
    const { articleId, searchTerm, skip, limit } = filter;

    this.logger.log(`Fetching articles citing article: ${articleId}`);

    // Helper function to construct the search condition for cited articles
    const getSearchCondition = (alias: string, nameAlias: string) => {
      if (!searchTerm) return '';
      const lowerSearch = `toLower($searchTerm)`;
      return `
      WHERE toLower(${nameAlias}) CONTAINS ${lowerSearch}
      OR toLower(${alias}.number) CONTAINS ${lowerSearch}
      OR toLower(${alias}.text) CONTAINS ${lowerSearch}
    `;
    };

    // Helper to fetch count query for articles citing other articles
    const getCountQuery = () => `
    MATCH (a:Article {number: $articleId})-[:CITES]->(b:Article)
    OPTIONAL MATCH (b)-[:IS_NAMED]->(n:Name)
    WITH b, n 
    ${getSearchCondition('b', 'n.short')}
    RETURN count(b) AS totalCount
  `;

    // Helper to fetch paginated articles query
    const getArticlesQuery = () => `
    MATCH (a:Article {number: $articleId})-[:CITES]->(b:Article)
    OPTIONAL MATCH (b)-[:IS_NAMED]->(n:Name)
    WITH b, n 
    ${getSearchCondition('b', 'n.short')}
    RETURN DISTINCT b, n.short AS name, elementId(b) AS elementId
    ORDER BY b.citing_cases DESC
    SKIP toInteger($skip) LIMIT toInteger($limit)
  `;

    try {
      // Execute the count and paginated queries concurrently using neo4jService
      const [countResult, articlesResult] = await Promise.all([
        this.neo4jService.runQuery(getCountQuery(), { articleId, searchTerm }),
        this.neo4jService.runQuery(getArticlesQuery(), {
          articleId,
          searchTerm,
          skip,
          limit,
        }),
      ]);

      // Extract the total count of cited articles
      const totalCount = countResult[0]?.get('totalCount').low || 0;

      // Process the articles
      const articles = articlesResult.map((record) => {
        const article = record.get('b').properties;
        const citedArticleId = record.get('elementId');
        const name = record.get('name');
        return { ...article, id: citedArticleId, name };
      });

      const elasticSearchResults = await Promise.all(
        articles.map(async (articleData) => {
          const query = {
            index: 'articles',
            body: {
              query: {
                match: {
                  number: articleData.number,
                },
              },
            },
          };
          const result = await this.elasticsearchService.search(query);
          return result.hits.hits.map((hit) => hit._source);
        }),
      );

      const flattenedResults = elasticSearchResults.flat().sort((a, b) => {
        const aHasName = a['name'] ? 1 : 0;
        const bHasName = b['name'] ? 1 : 0;
        return bHasName - aHasName;
      });
      return { articles: flattenedResults, total: totalCount };
    } catch (error) {
      this.logger.error(
        `Error fetching articles cited by article ${articleId}: ${error.message}`,
      );
      throw error;
    }
  }

  public async getArticleCitingOtherArticlesCount(articleId: string) {
    this.logger.log(`Fetching count of articles citing article: ${articleId}`);

    let query = `MATCH (a:Article{number: $articleId})-[:CITES]->(b:Article) `;
    query += `OPTIONAL MATCH (b:Article)-[:IS_NAMED]->(n:Name) `;
    query += `RETURN COUNT(b) AS count`;

    try {
      const result = await this.neo4jService.runQuery(query, { articleId });
      return result[0].get('count').low;
    } catch (error) {
      this.logger.error(
        `Error fetching count of articles citing article ${articleId}: ${error.message}`,
      );
      throw error;
    }
  }

  public async getCasesCitingArticle(filter: ArticlesCitationsFilterDto) {
    const { articleId, searchTerm, skip, limit } = filter;
    this.logger.log(`Fetching cases citing article: ${articleId}`);

    const getSearchCondition = (alias: string, caseNameAlias: string) => {
      if (!searchTerm) return '';
      const lowerSearch = `toLower($searchTerm)`;
      return `
      WHERE toLower(${caseNameAlias}) CONTAINS ${lowerSearch} 
      OR toLower(${alias}.number) CONTAINS ${lowerSearch}
      OR toLower(${alias}.judgment) CONTAINS ${lowerSearch}
      OR toLower(${alias}.facts) CONTAINS ${lowerSearch}
      OR toLower(${alias}.reasoning) CONTAINS ${lowerSearch}
      OR toLower(${alias}.headnotes) CONTAINS ${lowerSearch}
      OR toLower(${alias}.year) CONTAINS ${lowerSearch}
      OR toLower(${alias}.decision_type) CONTAINS ${lowerSearch}
      `;
    };

    // Helper to fetch count query for cases citing an article
    const getCountQuery = () => `
        MATCH (c:Case)-[:REFERS_TO]->(a:Article {number: $articleId})
        OPTIONAL MATCH (c)-[:IS_NAMED]->(n:Name)
        WITH c, n
        ${getSearchCondition('c', 'n.short')}
        RETURN count(c) AS totalCount
      `;

    // Helper to fetch paginated cases query
    const getCasesQuery = () => `
        MATCH (c:Case)-[:REFERS_TO]->(a:Article {number: $articleId})
        OPTIONAL MATCH (c)-[:IS_NAMED]->(n:Name)
        WITH c, n
        ${getSearchCondition('c', 'n.short')}
        RETURN DISTINCT c, n.short AS caseName, elementId(c) AS elementId
        ORDER BY c.citing_cases DESC
        SKIP toInteger($skip) LIMIT toInteger($limit)
      `;

    try {
      // Execute the count and paginated queries concurrently using neo4jService
      const [countResult, casesResult] = await Promise.all([
        this.neo4jService.runQuery(getCountQuery(), { articleId, searchTerm }),
        this.neo4jService.runQuery(getCasesQuery(), {
          articleId,
          searchTerm,
          skip,
          limit,
        }),
      ]);

      // Extract the total count of cases
      const totalCount = countResult[0]?.get('totalCount').low || 0;

      // Process the cases
      const cases = casesResult.map((record) => {
        const caseg = record.get('c').properties;
        const caseName = record.get('caseName');
        const caseId = record.get('elementId');
        return { ...caseg, id: caseId, caseName };
      });

      const elasticSearchResults = await Promise.all(
        cases.map(async (caseData) => {
          const query = {
            index: 'cases',
            body: {
              query: {
                match: {
                  number: caseData.number,
                },
              },
            },
          };
          const result = await this.elasticsearchService.search(query);
          return result.hits.hits.map((hit) => hit._source);
        }),
      );
      const flattenedResults = elasticSearchResults.flat().sort((a, b) => {
        const aHasName = a['caseName'] ? 1 : 0;
        const bHasName = b['caseName'] ? 1 : 0;
        return bHasName - aHasName;
      });

      return { cases: flattenedResults, total: totalCount };
    } catch (error) {
      this.logger.error(
        `Error fetching cases citing article ${articleId}: ${error.message}`,
      );
      throw error;
    }
  }

  public async getCasesCitingArticleCount(articleId: string) {
    this.logger.log(`Fetching count of cases citing article: ${articleId}`);

    let query = `MATCH (c:Case)-[:REFERS_TO]->(a:Article {number: $articleId}) `;
    query += `OPTIONAL MATCH (c:Case)-[:IS_NAMED]->(n:Name) `;
    query += `RETURN COUNT(c) AS count`;

    try {
      const result = await this.neo4jService.runQuery(query, { articleId });
      return result[0].get('count').low;
    } catch (error) {
      this.logger.error(
        `Error fetching count of cases citing article ${articleId}: ${error.message}`,
      );
      throw error;
    }
  }

  public async getReferencesWithArticle(filter: ArticlesCitationsFilterDto) {
    const { articleId, searchTerm, skip, limit } = filter;

    this.logger.log(`Fetching references with article: ${articleId}`);
    const getSearchCondition = (alias: string) => {
      if (!searchTerm) return '';
      const lowerSearch = `toLower($searchTerm)`;
      return `
          WHERE toLower(${alias}.context) CONTAINS ${lowerSearch}
          OR toLower(${alias}.text) CONTAINS ${lowerSearch}
        `;
    };

    // Helper to fetch count query for references
    const getCountQuery = () => `
        MATCH (r:Reference)-[:MENTIONS]->(a:Article {number: $articleId})
        ${getSearchCondition('r')}
        RETURN count(r) AS totalCount
      `;

    // Helper to fetch paginated references query
    const getReferencesQuery = () => `
        MATCH (r:Reference)-[:MENTIONS]->(a:Article {number: $articleId})
        ${getSearchCondition('r')}
        RETURN DISTINCT r
        SKIP toInteger($skip) LIMIT toInteger($limit)
      `;

    try {
      // Execute the count and paginated queries concurrently using neo4jService
      const [countResult, referencesResult] = await Promise.all([
        this.neo4jService.runQuery(getCountQuery(), { articleId, searchTerm }),
        this.neo4jService.runQuery(getReferencesQuery(), {
          articleId,
          searchTerm,
          skip,
          limit,
        }),
      ]);

      // Extract the total count of references
      const totalCount = countResult[0]?.get('totalCount').low || 0;

      // Process the references
      const references = referencesResult.map((record) => {
        const reference = record.get('r').properties;
        return { ...reference };
      });

      return { references, total: totalCount };
    } catch (error) {
      this.logger.error(
        `Error fetching references for article ${articleId}: ${error.message}`,
      );
      throw error;
    }
  }

  public async getReferencesWithArticleCount(articleId: string) {
    this.logger.log(`Fetching count of references with article: ${articleId}`);

    let query = `MATCH (r:Reference)-[:MENTIONS]->(a:Article {number: $articleId}) `;
    query += `RETURN COUNT(r) AS count`;

    try {
      const result = await this.neo4jService.runQuery(query, { articleId });
      return result[0].get('count').low;
    } catch (error) {
      this.logger.error(
        `Error fetching count of references with article ${articleId}: ${error.message}`,
      );
      throw error;
    }
  }
}
