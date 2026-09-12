package com.ptpmhdv.userservice.repository;

import com.ptpmhdv.userservice.model.User;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface UserRepository extends JpaRepository<User, String> {
    Optional<User> findByAuthUserId(String authUserId);
    Optional<User> findByEmail(String email);
    boolean existsByAuthUserId(String authUserId);
    boolean existsByEmail(String email);
    Page<User> findByEmailContainingIgnoreCaseOrFullNameContainingIgnoreCase(String email, String fullName, Pageable pageable);
}
