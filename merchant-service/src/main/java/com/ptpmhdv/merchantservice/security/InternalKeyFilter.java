package com.ptpmhdv.merchantservice.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ptpmhdv.merchantservice.dto.ApiResponse;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.AntPathMatcher;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

@Slf4j
@Component
public class InternalKeyFilter extends OncePerRequestFilter {

    @Value("${app.internal-key}")
    private String configuredInternalKey;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final AntPathMatcher pathMatcher = new AntPathMatcher();

    // Internal paths strictly requiring valid X-Internal-Key header
    private static final List<String> STRICT_INTERNAL_PATHS = List.of(
            "/api/merchants/*/active"
    );

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        String internalKeyHeader = request.getHeader("X-Internal-Key");
        boolean isValidInternalKey = internalKeyHeader != null && internalKeyHeader.equals(configuredInternalKey);

        request.setAttribute("isInternalCall", isValidInternalKey);

        String path = request.getRequestURI();

        boolean isStrictInternalPath = STRICT_INTERNAL_PATHS.stream().anyMatch(p -> pathMatcher.match(p, path));

        if (isStrictInternalPath && !isValidInternalKey) {
            log.warn("Unauthorized internal call attempt to path: {}", path);
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            ApiResponse<Void> apiResponse = ApiResponse.error("UNAUTHORIZED", "Missing or invalid X-Internal-Key header");
            objectMapper.writeValue(response.getWriter(), apiResponse);
            return;
        }

        filterChain.doFilter(request, response);
    }
}
